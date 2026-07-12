import type { FastifyInstance } from 'fastify';
import {
  createChatProjectSchema,
  updateChatProjectSchema,
  addProjectDocumentSchema,
  shareProjectSchema,
  createConversationSchema,
  renameConversationSchema,
  postChatMessageSchema,
  type McpEndpoint,
} from '@kravn/contracts';
import { newId } from '../crypto.js';
import { currentUser } from '../auth/plugin.js';
import { extractText } from '../chat/extract.js';
import type { Services } from '../services.js';
import { canConsumeMcpEndpoint } from '../mcp/endpoint-access.js';
import { parse, sendError } from './_helpers.js';

// Same data-plane rule as the MCP endpoint (endpoint-access.ts): consumption is by team membership; platform
// role/admin is not an axis. Keeps "which endpoints show in chat" identical to "which you can actually call".
const canUseVs = canConsumeMcpEndpoint;

export function chatRoutes(app: FastifyInstance, s: Services): void {
  const auth = { preHandler: [app.authenticate] };

  // What the client can pick from: enabled providers + virtual servers the user may use.
  app.get('/api/chat/options', auth, async (req) => {
    const u = currentUser(req);
    const providers = (await s.repos.llmProviders.list())
      .filter((p) => p.enabled)
      .map((p) => ({ id: p.id, name: p.name, models: p.models, defaultModel: p.defaultModel }));
    const mcpEndpoints = (await s.repos.mcpEndpoints.list())
      .filter((v) => v.enabled && canUseVs(v, u))
      .map((v) => ({ slug: v.slug, name: v.name }));
    return { providers, mcpEndpoints };
  });

  // Projects (Claude-Projects-style: instructions + documents injected as chat context)
  app.get('/api/chat/projects', auth, async (req) => ({ projects: await s.repos.chat.listProjects(currentUser(req).id) }));
  app.post('/api/chat/projects', auth, async (req, reply) => {
    const dto = parse(reply, createChatProjectSchema, req.body);
    if (!dto) return;
    const project = await s.repos.chat.createProject(currentUser(req).id, newId(), dto.name, dto.instructions ?? '');
    return reply.code(201).send({ project });
  });
  app.get('/api/chat/projects/:id', auth, async (req, reply) => {
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    const project = await s.repos.chat.getProjectForUser(u.id, id);
    if (!project) return sendError(reply, 404, 'not_found', 'Project not found.');
    const documents = (await s.repos.chat.listDocuments(id)).map((d) => ({
      id: d.id, projectId: d.projectId, name: d.name, size: d.content.length, createdAt: d.createdAt,
    }));
    const conversations = (await s.repos.chat.listConversations(u.id)).filter((c) => c.projectId === id);
    // Only the owner manages sharing, so only the owner sees the member list.
    const members = project.access === 'owner' ? await s.repos.chat.listProjectMembers(id) : [];
    return { project, documents, conversations, members };
  });
  app.put('/api/chat/projects/:id', auth, async (req, reply) => {
    const dto = parse(reply, updateChatProjectSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    const access = await s.repos.chat.getProjectAccess(u.id, id);
    if (!access) return sendError(reply, 404, 'not_found', 'Project not found.');
    if (access === 'viewer') return sendError(reply, 403, 'forbidden', 'You have read-only access to this project.');
    await s.repos.chat.updateProject(id, dto);
    return { project: await s.repos.chat.getProjectForUser(u.id, id) };
  });
  app.delete('/api/chat/projects/:id', auth, async (req, reply) => {
    // deleteProject is owner-gated internally (a non-owner call is a no-op).
    await s.repos.chat.deleteProject(currentUser(req).id, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // Sharing — owner-only: grant/revoke another Kravn user editor/viewer access to the project.
  app.post('/api/chat/projects/:id/share', auth, async (req, reply) => {
    const dto = parse(reply, shareProjectSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    if ((await s.repos.chat.getProjectAccess(u.id, id)) !== 'owner') {
      return sendError(reply, 403, 'forbidden', 'Only the project owner can share it.');
    }
    const target = await s.repos.users.getByEmail(dto.email);
    if (!target) return sendError(reply, 404, 'not_found', 'No Kravn user with that email.');
    if (target.id === u.id) return sendError(reply, 400, 'bad_request', 'You already own this project.');
    await s.repos.chat.shareProject(id, target.id, dto.role);
    return reply.code(201).send({ members: await s.repos.chat.listProjectMembers(id) });
  });
  app.delete('/api/chat/projects/:id/share/:userId', auth, async (req, reply) => {
    const u = currentUser(req);
    const { id, userId } = req.params as { id: string; userId: string };
    if ((await s.repos.chat.getProjectAccess(u.id, id)) !== 'owner') {
      return sendError(reply, 403, 'forbidden', 'Only the project owner can manage sharing.');
    }
    await s.repos.chat.unshareProject(id, userId);
    return reply.code(204).send();
  });

  // Project documents (owner + editors may add/remove; viewers are read-only).
  app.post('/api/chat/projects/:id/documents', auth, async (req, reply) => {
    const dto = parse(reply, addProjectDocumentSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    const access = await s.repos.chat.getProjectAccess(u.id, id);
    if (!access) return sendError(reply, 404, 'not_found', 'Project not found.');
    if (access === 'viewer') return sendError(reply, 403, 'forbidden', 'You have read-only access to this project.');
    const doc = await s.repos.chat.addDocument(newId(), id, u.id, dto.name, dto.content);
    return reply.code(201).send({ document: { id: doc.id, projectId: doc.projectId, name: doc.name, size: doc.content.length, createdAt: doc.createdAt } });
  });
  app.delete('/api/chat/projects/:id/documents/:docId', auth, async (req, reply) => {
    const u = currentUser(req);
    const { id, docId } = req.params as { id: string; docId: string };
    const access = await s.repos.chat.getProjectAccess(u.id, id);
    if (!access) return sendError(reply, 404, 'not_found', 'Project not found.');
    if (access === 'viewer') return sendError(reply, 403, 'forbidden', 'You have read-only access to this project.');
    await s.repos.chat.deleteDocument(id, docId);
    return reply.code(204).send();
  });

  // Conversations
  app.get('/api/chat/conversations', auth, async (req) => ({ conversations: await s.repos.chat.listConversations(currentUser(req).id) }));
  app.post('/api/chat/conversations', auth, async (req, reply) => {
    const dto = parse(reply, createConversationSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    // A conversation may only be bound to a project the caller can access — owner OR a shared member
    // (getProjectForUser is fail-closed), which prevents binding to a project they were never granted.
    if (dto.projectId && !(await s.repos.chat.getProjectForUser(u.id, dto.projectId))) {
      return sendError(reply, 404, 'not_found', 'Project not found.');
    }
    const conversation = await s.repos.chat.createConversation(u.id, {
      id: newId(),
      projectId: dto.projectId ?? null,
      title: dto.title,
      providerId: dto.providerId,
      model: dto.model,
      vserverSlug: dto.vserverSlug,
    });
    return reply.code(201).send({ conversation });
  });
  app.get('/api/chat/conversations/:id', auth, async (req, reply) => {
    const u = currentUser(req);
    const conversation = await s.repos.chat.getConversation(u.id, (req.params as { id: string }).id);
    if (!conversation) return sendError(reply, 404, 'not_found', 'Conversation not found.');
    const messages = await s.repos.chat.listMessages(conversation.id);
    const attachments = await s.repos.chat.listAttachmentsByMessage(conversation.id);
    return { conversation, messages, attachments };
  });
  app.put('/api/chat/conversations/:id', auth, async (req, reply) => {
    const dto = parse(reply, renameConversationSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    const conv = await s.repos.chat.getConversation(u.id, id);
    if (!conv) return sendError(reply, 404, 'not_found', 'Conversation not found.');
    const title = dto.title.trim();
    await s.repos.chat.renameConversation(u.id, id, title);
    return { conversation: { ...conv, title } };
  });
  app.delete('/api/chat/conversations/:id', auth, async (req, reply) => {
    await s.repos.chat.deleteConversation(currentUser(req).id, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // Upload a file into a conversation → extract its text for context. Returns metadata only.
  app.post('/api/chat/conversations/:id/attachments', auth, async (req, reply) => {
    const u = currentUser(req);
    const convId = (req.params as { id: string }).id;
    if (!(await s.repos.chat.getConversation(u.id, convId))) return sendError(reply, 404, 'not_found', 'Conversation not found.');

    let file;
    try {
      file = await req.file();
    } catch {
      return sendError(reply, 413, 'too_large', 'File is too large (max 10 MB).');
    }
    if (!file) return sendError(reply, 400, 'no_file', 'No file uploaded.');

    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch {
      return sendError(reply, 413, 'too_large', 'File is too large (max 10 MB).');
    }
    if (file.file.truncated) return sendError(reply, 413, 'too_large', 'File is too large (max 10 MB).');

    let extracted: { kind: 'pdf' | 'document' | 'spreadsheet' | 'text' | 'other'; text: string };
    try {
      extracted = await extractText(file.filename, file.mimetype, buf);
    } catch (err) {
      s.log.warn({ err, name: file.filename }, 'attachment text extraction failed');
      extracted = { kind: 'other', text: '' };
    }

    let attachment;
    try {
      attachment = await s.repos.chat.addAttachment({
        id: newId(),
        conversationId: convId,
        userId: u.id,
        name: file.filename,
        mime: file.mimetype || 'application/octet-stream',
        size: buf.length,
        kind: extracted.kind,
        extractedText: extracted.text,
        dataB64: buf.toString('base64'),
      });
    } catch (err) {
      // e.g. MySQL max_allowed_packet exceeded by the base64 payload — give a clear message, not a 500.
      s.log.error({ err, name: file.filename, size: buf.length }, 'attachment store failed');
      return sendError(reply, 400, 'store_failed', 'Could not store the file (it may be too large for the database). Try a smaller file.');
    }
    return reply.code(201).send({ attachment });
  });

  // Download an attachment's bytes (uploaded files or interpreter-produced files), owner-scoped.
  app.get('/api/chat/attachments/:id/download', auth, async (req, reply) => {
    const found = await s.repos.chat.getAttachmentBytes(currentUser(req).id, (req.params as { id: string }).id);
    if (!found) return sendError(reply, 404, 'not_found', 'Attachment not found.');
    const safeName = found.name.replace(/[^\w.\- ]+/g, '_');
    return reply
      .header('content-type', found.mime || 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${safeName}"`)
      .send(Buffer.from(found.b64, 'base64'));
  });

  // Send a message → assistant reply (runs tools if the conversation has a virtual server)
  app.post('/api/chat/conversations/:id/messages', auth, async (req, reply) => {
    const dto = parse(reply, postChatMessageSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const convId = (req.params as { id: string }).id;
    try {
      const message = await s.chat.send(u, convId, dto.content, dto.attachmentIds);
      // Return any files the interpreter produced for this reply so the client can show the download immediately.
      const attachments = (await s.repos.chat.listAttachmentsByMessage(convId)).filter((a) => a.messageId === message.id);
      return { message, attachments };
    } catch (err) {
      return sendError(reply, 400, 'chat_failed', err instanceof Error ? err.message : 'Chat failed.');
    }
  });
}
