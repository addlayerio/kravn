import type { FastifyInstance } from 'fastify';
import {
  createChatProjectSchema,
  updateChatProjectSchema,
  addProjectDocumentSchema,
  shareProjectSchema,
  createConversationSchema,
  updateConversationSchema,
  createScheduleSchema,
  updateScheduleSchema,
  createUserPromptSchema,
  updateUserPromptSchema,
  createMemorySchema,
  updateMemorySchema,
  createAssistantSchema,
  updateAssistantSchema,
  postChatMessageSchema,
  type McpEndpoint,
} from '@kravn/contracts';
import { newId } from '../crypto.js';
import { currentUser } from '../auth/plugin.js';
import { extractText } from '../chat/extract.js';
import type { Services } from '../services.js';
import { canConsumeMcpEndpoint } from '../mcp/endpoint-access.js';
import { computeNextRun } from '../schedules/scheduler.service.js';
import { parse, sendError } from './_helpers.js';

// Same data-plane rule as the MCP endpoint (endpoint-access.ts): consumption is by team membership; platform
// role/admin is not an axis. Keeps "which endpoints show in chat" identical to "which you can actually call".
const canUseVs = canConsumeMcpEndpoint;

/** Keep only the tool ids the caller is currently entitled to (via some consumable endpoint) — so pinning a
 *  project's tools can never grant access to a tool the user couldn't already reach. */
async function filterEntitledTools(s: Services, u: ReturnType<typeof currentUser>, toolIds: string[]): Promise<string[]> {
  const available = new Set((await s.chat.listAvailableTools(u)).map((a) => a.id));
  return toolIds.filter((id) => available.has(id));
}

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

  // Flat list of tools the caller is entitled to (union across their consumable MCP endpoints) — for the
  // project tool picker. A read over the existing MCP governance; it grants nothing.
  app.get('/api/chat/available-tools', auth, async (req) => ({ tools: await s.chat.listAvailableTools(currentUser(req)) }));

  // Other Kravn users the caller can share a project with — a minimal {id,email} directory for the share picker
  // (excludes the caller and disabled accounts). Sharing is a collaboration feature, so an end-user may see it.
  app.get('/api/chat/shareable-users', auth, async (req) => {
    const meId = currentUser(req).id;
    const users = (await s.repos.users.list())
      .filter((u) => u.id !== meId && !u.disabled)
      .map((u) => ({ id: u.id, email: u.email, name: u.name || '' }))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' }));
    return { users };
  });

  // Projects (Claude-Projects-style: instructions + documents injected as chat context)
  app.get('/api/chat/projects', auth, async (req) => ({ projects: await s.repos.chat.listProjects(currentUser(req).id) }));
  app.post('/api/chat/projects', auth, async (req, reply) => {
    const dto = parse(reply, createChatProjectSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    // Only pin tools the caller is actually entitled to (a filter, not a grant) — junk/unentitled ids are dropped.
    const toolIds = dto.toolIds ? await filterEntitledTools(s, u, dto.toolIds) : [];
    const project = await s.repos.chat.createProject(u.id, newId(), dto.name, dto.instructions ?? '', toolIds);
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
    let patch: typeof dto = dto;
    if (dto.toolIds !== undefined) {
      // A saver (owner OR editor) may only ADD tools they are entitled to — but must NOT drop existing pins they
      // simply can't see (an editor's entitlement is narrower than the owner's; those tools aren't in their
      // picker). So keep an incoming id if it's entitled to the saver OR was already pinned on the project.
      const current = await s.repos.chat.getProjectForUser(u.id, id);
      const kept = current ? new Set(current.toolIds) : new Set<string>();
      const entitled = new Set((await s.chat.listAvailableTools(u)).map((a) => a.id));
      patch = { ...dto, toolIds: dto.toolIds.filter((tid) => entitled.has(tid) || kept.has(tid)) };
    }
    await s.repos.chat.updateProject(id, patch);
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
  app.get('/api/chat/conversations', auth, async (req) => {
    const archived = (req.query as { archived?: string }).archived === '1';
    return { conversations: await s.repos.chat.listConversations(currentUser(req).id, { archived }) };
  });
  app.post('/api/chat/conversations', auth, async (req, reply) => {
    const dto = parse(reply, createConversationSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    // A conversation may only be bound to a project the caller can access — owner OR a shared member
    // (getProjectForUser is fail-closed), which prevents binding to a project they were never granted.
    if (dto.projectId && !(await s.repos.chat.getProjectForUser(u.id, dto.projectId))) {
      return sendError(reply, 404, 'not_found', 'Project not found.');
    }
    // An assistant preset may only be one the caller owns (getAssistant is owner-scoped, fail-closed).
    if (dto.assistantId && !(await s.repos.chat.getAssistant(u.id, dto.assistantId))) {
      return sendError(reply, 404, 'not_found', 'Assistant not found.');
    }
    const conversation = await s.repos.chat.createConversation(u.id, {
      id: newId(),
      projectId: dto.projectId ?? null,
      title: dto.title,
      providerId: dto.providerId,
      model: dto.model,
      vserverSlug: dto.vserverSlug,
      assistantId: dto.assistantId ?? null,
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
    const dto = parse(reply, updateConversationSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    const conv = await s.repos.chat.getConversation(u.id, id);
    if (!conv) return sendError(reply, 404, 'not_found', 'Conversation not found.');
    // Moving into a project requires access to that project (owner OR shared member); null clears it.
    if (dto.projectId && !(await s.repos.chat.getProjectForUser(u.id, dto.projectId))) {
      return sendError(reply, 404, 'not_found', 'Project not found.');
    }
    await s.repos.chat.updateConversation(u.id, id, {
      title: dto.title?.trim(),
      tags: dto.tags,
      projectId: dto.projectId,
      pinned: dto.pinned,
      archived: dto.archived,
      webSearch: dto.webSearch,
    });
    return { conversation: (await s.repos.chat.getConversation(u.id, id)) ?? conv };
  });
  app.delete('/api/chat/conversations/:id', auth, async (req, reply) => {
    await s.repos.chat.deleteConversation(currentUser(req).id, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // Scheduled tasks — run a prompt on a cron/calendar schedule; the result lands in a new conversation.
  app.get('/api/chat/schedules', auth, async (req) => ({ schedules: await s.repos.schedules.listByUser(currentUser(req).id) }));
  app.post('/api/chat/schedules', auth, async (req, reply) => {
    const dto = parse(reply, createScheduleSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    if (dto.projectId && !(await s.repos.chat.getProjectForUser(u.id, dto.projectId))) {
      return sendError(reply, 404, 'not_found', 'Project not found.');
    }
    const cron = dto.cron ?? '';
    const runAt = dto.runAt ?? '';
    const timezone = dto.timezone || 'UTC';
    if (dto.kind === 'cron' && !cron.trim()) return sendError(reply, 400, 'bad_request', 'A cron expression is required.');
    if (dto.kind === 'once' && !runAt.trim()) return sendError(reply, 400, 'bad_request', 'A date/time is required.');
    const enabled = dto.enabled ?? true;
    const nextRunAt = enabled ? computeNextRun(dto.kind, cron, runAt, timezone, new Date()) : null;
    if (enabled && dto.kind === 'cron' && nextRunAt === null) return sendError(reply, 400, 'bad_request', 'Invalid cron expression.');
    const schedule = await s.repos.schedules.create(u.id, newId(), {
      name: dto.name, prompt: dto.prompt, providerId: dto.providerId, model: dto.model,
      vserverSlug: dto.vserverSlug ?? '', projectId: dto.projectId ?? null,
      kind: dto.kind, cron, runAt, timezone, enabled, nextRunAt,
    });
    return reply.code(201).send({ schedule });
  });
  app.put('/api/chat/schedules/:id', auth, async (req, reply) => {
    const dto = parse(reply, updateScheduleSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    const existing = await s.repos.schedules.get(u.id, id);
    if (!existing) return sendError(reply, 404, 'not_found', 'Schedule not found.');
    if (dto.projectId && !(await s.repos.chat.getProjectForUser(u.id, dto.projectId))) {
      return sendError(reply, 404, 'not_found', 'Project not found.');
    }
    const m = { ...existing, ...dto };
    const enabled = dto.enabled ?? existing.enabled;
    const nextRunAt = enabled ? computeNextRun(m.kind, m.cron ?? '', m.runAt ?? '', m.timezone || 'UTC', new Date()) : null;
    if (enabled && m.kind === 'cron' && nextRunAt === null) return sendError(reply, 400, 'bad_request', 'Invalid cron expression.');
    await s.repos.schedules.update(u.id, id, { ...dto, nextRunAt });
    return { schedule: await s.repos.schedules.get(u.id, id) };
  });
  app.delete('/api/chat/schedules/:id', auth, async (req, reply) => {
    await s.repos.schedules.delete(currentUser(req).id, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // Personal prompt library — a user's own reusable prompt templates.
  app.get('/api/chat/prompts', auth, async (req) => ({ prompts: await s.repos.chat.listPrompts(currentUser(req).id) }));
  app.post('/api/chat/prompts', auth, async (req, reply) => {
    const dto = parse(reply, createUserPromptSchema, req.body);
    if (!dto) return;
    const prompt = await s.repos.chat.createPrompt(currentUser(req).id, newId(), dto.name.trim(), dto.content);
    return reply.code(201).send({ prompt });
  });
  app.put('/api/chat/prompts/:id', auth, async (req, reply) => {
    const dto = parse(reply, updateUserPromptSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    await s.repos.chat.updatePrompt(u.id, id, dto);
    return { prompt: (await s.repos.chat.listPrompts(u.id)).find((p) => p.id === id) };
  });
  app.delete('/api/chat/prompts/:id', auth, async (req, reply) => {
    await s.repos.chat.deletePrompt(currentUser(req).id, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // Persistent memory — durable facts the user wants the assistant to know in every chat.
  app.get('/api/chat/memory', auth, async (req) => ({ memory: await s.repos.chat.listMemory(currentUser(req).id) }));
  app.post('/api/chat/memory', auth, async (req, reply) => {
    const dto = parse(reply, createMemorySchema, req.body);
    if (!dto) return;
    const item = await s.repos.chat.createMemory(currentUser(req).id, newId(), dto.content.trim());
    return reply.code(201).send({ item });
  });
  app.put('/api/chat/memory/:id', auth, async (req, reply) => {
    const dto = parse(reply, updateMemorySchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    await s.repos.chat.updateMemory(u.id, id, dto.content.trim());
    return { item: (await s.repos.chat.listMemory(u.id)).find((m) => m.id === id) };
  });
  app.delete('/api/chat/memory/:id', auth, async (req, reply) => {
    await s.repos.chat.deleteMemory(currentUser(req).id, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // Assistant presets — reusable persona + default model + tools a chat can be started from.
  app.get('/api/chat/assistants', auth, async (req) => ({ assistants: await s.repos.chat.listAssistants(currentUser(req).id) }));
  app.post('/api/chat/assistants', auth, async (req, reply) => {
    const dto = parse(reply, createAssistantSchema, req.body);
    if (!dto) return;
    const assistant = await s.repos.chat.createAssistant(currentUser(req).id, newId(), {
      name: dto.name.trim(), instructions: dto.instructions, providerId: dto.providerId, model: dto.model, vserverSlug: dto.vserverSlug,
    });
    return reply.code(201).send({ assistant });
  });
  app.put('/api/chat/assistants/:id', auth, async (req, reply) => {
    const dto = parse(reply, updateAssistantSchema, req.body);
    if (!dto) return;
    const u = currentUser(req);
    const id = (req.params as { id: string }).id;
    if (!(await s.repos.chat.getAssistant(u.id, id))) return sendError(reply, 404, 'not_found', 'Assistant not found.');
    await s.repos.chat.updateAssistant(u.id, id, dto);
    return { assistant: await s.repos.chat.getAssistant(u.id, id) };
  });
  app.delete('/api/chat/assistants/:id', auth, async (req, reply) => {
    await s.repos.chat.deleteAssistant(currentUser(req).id, (req.params as { id: string }).id);
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
