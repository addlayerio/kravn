import type { FastifyInstance } from 'fastify';
import {
  createChatProjectSchema,
  updateChatProjectSchema,
  addProjectDocumentSchema,
  createConversationSchema,
  postChatMessageSchema,
  type VirtualServer,
} from '@kravn/contracts';
import { newId } from '../crypto.js';
import { currentUser } from '../auth/plugin.js';
import { extractText } from '../chat/extract.js';
import type { Services } from '../services.js';
import { canConsumeVirtualServer } from '../mcp/vs-access.js';
import { parse, sendError } from './_helpers.js';

// Same data-plane rule as the MCP endpoint (vs-access.ts): consumption is by team membership; platform
// role/admin is not an axis. Keeps "which endpoints show in chat" identical to "which you can actually call".
const canUseVs = canConsumeVirtualServer;

export function chatRoutes(app: FastifyInstance, s: Services): void {
  const auth = { preHandler: [app.authenticate] };

  // What the client can pick from: enabled providers + virtual servers the user may use.
  app.get('/api/chat/options', auth, async (req) => {
    const u = currentUser(req);
    const providers = (await s.repos.llmProviders.list())
      .filter((p) => p.enabled)
      .map((p) => ({ id: p.id, name: p.name, models: p.models, defaultModel: p.defaultModel }));
    const virtualServers = (await s.repos.virtualServers.list())
      .filter((v) => v.enabled && canUseVs(v, u))
      .map((v) => ({ slug: v.slug, name: v.name }));
    return { providers, virtualServers };
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
    const project = await s.repos.chat.getProject(u.id, id);
    if (!project) return sendError(reply, 404, 'not_found', 'Project not found.');
    const documents = (await s.repos.chat.listDocuments(id)).map((d) => ({
      id: d.id, projectId: d.projectId, name: d.name, size: d.content.length, createdAt: d.createdAt,
    }));
    const conversations = (await s.repos.chat.listConversations(u.id)).filter((c) => c.projectId === id);
    return { project, documents, conversations };
  });
  app.put('/api/chat/projects/:id', auth, async (req, reply) => {
    const dto = parse(reply, updateChatProjectSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    if (!(await s.repos.chat.getProject(u.id, id))) return sendError(reply, 404, 'not_found', 'Project not found.');
    await s.repos.chat.updateProject(u.id, id, dto);
    return { project: await s.repos.chat.getProject(u.id, id) };
  });
  app.delete('/api/chat/projects/:id', auth, async (req, reply) => {
    await s.repos.chat.deleteProject(currentUser(req).id, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // Project documents
  app.post('/api/chat/projects/:id/documents', auth, async (req, reply) => {
    const dto = parse(reply, addProjectDocumentSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    if (!(await s.repos.chat.getProject(u.id, id))) return sendError(reply, 404, 'not_found', 'Project not found.');
    const doc = await s.repos.chat.addDocument(newId(), id, u.id, dto.name, dto.content);
    return reply.code(201).send({ document: { id: doc.id, projectId: doc.projectId, name: doc.name, size: doc.content.length, createdAt: doc.createdAt } });
  });
  app.delete('/api/chat/projects/:id/documents/:docId', auth, async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string };
    await s.repos.chat.deleteDocument(currentUser(req).id, id, docId);
    return reply.code(204).send();
  });

  // Conversations
  app.get('/api/chat/conversations', auth, async (req) => ({ conversations: await s.repos.chat.listConversations(currentUser(req).id) }));
  app.post('/api/chat/conversations', auth, async (req, reply) => {
    const dto = parse(reply, createConversationSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    // A conversation may only be bound to a project the caller owns (prevents cross-tenant context leak).
    if (dto.projectId && !(await s.repos.chat.getProject(u.id, dto.projectId))) {
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
