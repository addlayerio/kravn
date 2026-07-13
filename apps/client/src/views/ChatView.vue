<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ChatConversation, ChatMessage, ChatProject, ChatProjectDocument, ChatAttachment, ProjectMember, ChatSchedule, ChatUserPrompt, ChatMemory, ChatAssistant } from '@kravn/contracts';
import { api, ApiError } from '../api';
import { useAuthStore } from '../stores/auth';
import { renderMarkdown } from '../lib/markdown';
import RavenLogo from '../RavenLogo.vue';

interface ProviderOpt { id: string; name: string; models: string[]; defaultModel: string }
interface VsOpt { slug: string; name: string }
interface ProjectDetail { project: ChatProject; documents: ChatProjectDocument[]; conversations: ChatConversation[]; members: ProjectMember[] }

const auth = useAuthStore();
const router = useRouter();

const providers = ref<ProviderOpt[]>([]);
const vservers = ref<VsOpt[]>([]);
const conversations = ref<ChatConversation[]>([]);
const projects = ref<ChatProject[]>([]);
const schedules = ref<ChatSchedule[]>([]);
const chatSearch = ref('');
const activeTag = ref<string | null>(null);
// Distinct tags across all chats, for the filter bar (case-insensitive de-dupe, sorted).
const allTags = computed(() => {
  const seen = new Map<string, string>();
  for (const c of conversations.value) for (const t of c.tags ?? []) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
});
const filteredConversations = computed(() => {
  const q = chatSearch.value.trim().toLowerCase();
  const tag = activeTag.value?.toLowerCase() ?? null;
  return conversations.value.filter((c) => {
    if (q && !(c.title || 'New chat').toLowerCase().includes(q)) return false;
    if (tag && !(c.tags ?? []).some((t) => t.toLowerCase() === tag)) return false;
    return true;
  });
});
function toggleTagFilter(t: string) {
  activeTag.value = activeTag.value?.toLowerCase() === t.toLowerCase() ? null : t;
}

// Exactly one of these is active at a time.
const current = ref<ChatConversation | null>(null);
const project = ref<ProjectDetail | null>(null);

const messages = ref<ChatMessage[]>([]);
const attachments = ref<ChatAttachment[]>([]); // sent attachments, linked to messages
const input = ref('');
const sending = ref(false);
const thread = ref<HTMLElement | null>(null);

// Files staged in the composer (uploaded, not yet sent).
const pending = ref<ChatAttachment[]>([]);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function attachmentsFor(messageId: string): ChatAttachment[] {
  return attachments.value.filter((a) => a.messageId === messageId);
}
async function downloadAttachment(a: ChatAttachment) {
  if (a.id.startsWith('tmp-') || a.id.startsWith('err-')) return; // optimistic-only, not persisted yet
  try {
    const blob = await api.blob(`/api/chat/attachments/${a.id}/download`);
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url;
    el.download = a.name;
    el.click();
    URL.revokeObjectURL(url);
  } catch {
    /* ignore download errors */
  }
}
function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// New-chat modal
const showNew = ref(false);
const nc = reactive({ assistantId: '', providerId: '', model: '', vserverSlug: '', projectId: '' });
const newError = ref('');

// New-project modal
const showNewProject = ref(false);
const np = reactive({ name: '', instructions: '' });
const projectError = ref('');

// Project panel edit state
const savingInstr = ref(false);
const newDoc = reactive({ name: '', content: '' });
const docBusy = ref(false);

// Sharing — the caller's access to the open project drives what they can do.
const isOwner = computed(() => project.value?.project.access === 'owner');
const canEdit = computed(() => project.value != null && project.value.project.access !== 'viewer'); // owner OR editor
const share = reactive({ email: '', role: 'viewer' as 'editor' | 'viewer' });
const sharing = ref(false);
const shareError = ref('');
async function shareProject() {
  if (!project.value || !share.email.trim()) return;
  sharing.value = true;
  shareError.value = '';
  try {
    const res = await api.post<{ members: ProjectMember[] }>(`/api/chat/projects/${project.value.project.id}/share`, {
      email: share.email.trim(),
      role: share.role,
    });
    project.value.members = res.members;
    share.email = '';
  } catch (e) {
    shareError.value = e instanceof ApiError ? e.message : 'Could not share the project.';
  } finally {
    sharing.value = false;
  }
}
async function unshareMember(m: ProjectMember) {
  if (!project.value) return;
  await api.del(`/api/chat/projects/${project.value.project.id}/share/${m.userId}`);
  project.value.members = project.value.members.filter((x) => x.userId !== m.userId);
}

async function load() {
  const [opts, convs, projs, scheds, assts] = await Promise.all([
    api.get<{ providers: ProviderOpt[]; mcpEndpoints: VsOpt[] }>('/api/chat/options'),
    api.get<{ conversations: ChatConversation[] }>('/api/chat/conversations'),
    api.get<{ projects: ChatProject[] }>('/api/chat/projects'),
    api.get<{ schedules: ChatSchedule[] }>('/api/chat/schedules'),
    api.get<{ assistants: ChatAssistant[] }>('/api/chat/assistants'),
  ]);
  providers.value = opts.providers;
  vservers.value = opts.mcpEndpoints;
  conversations.value = convs.conversations;
  projects.value = projs.projects;
  schedules.value = scheds.schedules;
  assistants.value = assts.assistants;
}
async function loadSchedules() {
  schedules.value = (await api.get<{ schedules: ChatSchedule[] }>('/api/chat/schedules')).schedules;
}
onMounted(load);

async function scrollDown() {
  await nextTick();
  if (thread.value) thread.value.scrollTop = thread.value.scrollHeight;
}

async function open(c: ChatConversation) {
  project.value = null;
  scheduleView.value = false;
  editingTitle.value = false;
  pending.value = [];
  const res = await api.get<{ conversation: ChatConversation; messages: ChatMessage[]; attachments: ChatAttachment[] }>(`/api/chat/conversations/${c.id}`);
  current.value = res.conversation;
  messages.value = res.messages;
  attachments.value = res.attachments ?? [];
  scrollDown();
}

// ── Inline rename of the conversation title (click title → input; Enter/blur saves, Esc cancels) ──
const editingTitle = ref(false);
const titleDraft = ref('');
const titleInput = ref<HTMLInputElement | null>(null);
async function startRenameTitle() {
  if (!current.value) return;
  titleDraft.value = current.value.title || '';
  editingTitle.value = true;
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
}
async function saveTitle() {
  if (!editingTitle.value || !current.value) return;
  editingTitle.value = false; // guard: Enter fires this AND then blur fires it again — only save once
  const title = titleDraft.value.trim();
  if (!title || title === current.value.title) return; // no-op on empty / unchanged
  const id = current.value.id;
  try {
    await api.put<{ conversation: ChatConversation }>(`/api/chat/conversations/${id}`, { title });
    current.value.title = title;
    const c = conversations.value.find((x) => x.id === id);
    if (c) c.title = title;
  } catch {
    /* keep the previous title on failure */
  }
}
function cancelRenameTitle() {
  editingTitle.value = false; // the ensuing blur won't save — the guard in saveTitle sees false
}

// ── Tags (folders) on the current chat ────────────────────────────────────
const tagDraft = ref('');
async function persistTags(tags: string[]) {
  if (!current.value) return;
  const id = current.value.id;
  const prev = current.value.tags ?? [];
  current.value.tags = tags;
  const c = conversations.value.find((x) => x.id === id);
  if (c) c.tags = tags;
  try {
    await api.put<{ conversation: ChatConversation }>(`/api/chat/conversations/${id}`, { tags });
  } catch {
    current.value.tags = prev; // roll back on failure
    if (c) c.tags = prev;
  }
}
function addTag() {
  const t = tagDraft.value.trim();
  tagDraft.value = '';
  if (!t || !current.value) return;
  const existing = current.value.tags ?? [];
  if (existing.some((x) => x.toLowerCase() === t.toLowerCase())) return; // no dupes
  persistTags([...existing, t]);
}
function removeTag(t: string) {
  if (!current.value) return;
  persistTags((current.value.tags ?? []).filter((x) => x !== t));
}

// ── Projects ──────────────────────────────────────────────────────────────
async function openProject(p: ChatProject) {
  current.value = null;
  scheduleView.value = false;
  const res = await api.get<ProjectDetail>(`/api/chat/projects/${p.id}`);
  project.value = res;
  newDoc.name = '';
  newDoc.content = '';
}
function openNewProject() {
  projectError.value = '';
  np.name = '';
  np.instructions = '';
  showNewProject.value = true;
}
async function createProject() {
  projectError.value = '';
  if (!np.name.trim()) {
    projectError.value = 'Give the project a name.';
    return;
  }
  try {
    const res = await api.post<{ project: ChatProject }>('/api/chat/projects', { name: np.name.trim(), instructions: np.instructions });
    showNewProject.value = false;
    projects.value.push(res.project);
    await openProject(res.project);
  } catch (e) {
    projectError.value = e instanceof ApiError ? e.message : 'Could not create project.';
  }
}
async function saveInstructions() {
  if (!project.value) return;
  savingInstr.value = true;
  try {
    const res = await api.put<{ project: ChatProject }>(`/api/chat/projects/${project.value.project.id}`, {
      instructions: project.value.project.instructions,
    });
    project.value.project = res.project;
    const idx = projects.value.findIndex((p) => p.id === res.project.id);
    if (idx >= 0) projects.value[idx] = res.project;
  } finally {
    savingInstr.value = false;
  }
}
async function addDocument() {
  if (!project.value || !newDoc.name.trim() || !newDoc.content.trim()) return;
  docBusy.value = true;
  try {
    const res = await api.post<{ document: ChatProjectDocument }>(`/api/chat/projects/${project.value.project.id}/documents`, {
      name: newDoc.name.trim(),
      content: newDoc.content,
    });
    project.value.documents.push(res.document);
    newDoc.name = '';
    newDoc.content = '';
  } finally {
    docBusy.value = false;
  }
}
async function deleteDocument(doc: ChatProjectDocument) {
  if (!project.value) return;
  await api.del(`/api/chat/projects/${project.value.project.id}/documents/${doc.id}`);
  project.value.documents = project.value.documents.filter((d) => d.id !== doc.id);
}
async function deleteConversation(c: ChatConversation) {
  if (!confirm(`Delete chat “${c.title || 'New chat'}”? This can't be undone.`)) return;
  try {
    await api.del(`/api/chat/conversations/${c.id}`);
  } catch (e) {
    // Any error means the server never confirmed the delete — keep the chat in the list.
    alert(e instanceof ApiError ? e.message : "Could not delete the chat — please try again.");
    return;
  }
  conversations.value = conversations.value.filter((x) => x.id !== c.id);
  if (project.value) project.value.conversations = project.value.conversations.filter((x) => x.id !== c.id);
  if (current.value?.id === c.id) {
    current.value = null;
    messages.value = [];
    editingTitle.value = false;
  }
}
async function deleteProject(p: ChatProject) {
  if (!confirm(`Delete project “${p.name}”? Its documents are removed; its chats are kept.`)) return;
  await api.del(`/api/chat/projects/${p.id}`);
  projects.value = projects.value.filter((x) => x.id !== p.id);
  if (project.value?.project.id === p.id) project.value = null;
}

// ── New chat ──────────────────────────────────────────────────────────────
// ── Scheduled tasks ─────────────────────────────────────────────────────────
const scheduleView = ref(false);
const editingScheduleId = ref<string | null>(null);
const savingSchedule = ref(false);
const scheduleError = ref('');
const sf = reactive({
  name: '', prompt: '', providerId: '', model: '', vserverSlug: '', projectId: '',
  kind: 'cron' as 'cron' | 'once', cron: '0 9 * * 1', runAt: '', timezone: 'UTC', enabled: true,
});
function scheduleById(id: string | null): ChatSchedule | undefined {
  return id ? schedules.value.find((x) => x.id === id) : undefined;
}
function openScheduleNew() {
  current.value = null;
  project.value = null;
  editingScheduleId.value = null;
  scheduleError.value = '';
  const p = providers.value[0];
  Object.assign(sf, {
    name: '', prompt: '', providerId: p?.id ?? '', model: p?.defaultModel ?? p?.models[0] ?? '',
    vserverSlug: '', projectId: '', kind: 'cron', cron: '0 9 * * 1', runAt: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', enabled: true,
  });
  scheduleView.value = true;
}
function openSchedule(s: ChatSchedule) {
  current.value = null;
  project.value = null;
  editingScheduleId.value = s.id;
  scheduleError.value = '';
  Object.assign(sf, {
    name: s.name, prompt: s.prompt, providerId: s.providerId, model: s.model, vserverSlug: s.vserverSlug,
    projectId: s.projectId ?? '', kind: s.kind, cron: s.cron || '0 9 * * 1', runAt: s.runAt,
    timezone: s.timezone || 'UTC', enabled: s.enabled,
  });
  scheduleView.value = true;
}
function onScheduleProviderChange() {
  const p = providers.value.find((x) => x.id === sf.providerId);
  sf.model = p?.defaultModel ?? p?.models[0] ?? '';
}
async function saveSchedule() {
  scheduleError.value = '';
  if (!sf.name.trim() || !sf.prompt.trim() || !sf.providerId || !sf.model) {
    scheduleError.value = 'Name, prompt, provider and model are required.';
    return;
  }
  savingSchedule.value = true;
  try {
    const body = {
      name: sf.name.trim(), prompt: sf.prompt, providerId: sf.providerId, model: sf.model,
      vserverSlug: sf.vserverSlug, kind: sf.kind, cron: sf.cron, runAt: sf.runAt, timezone: sf.timezone, enabled: sf.enabled,
      ...(sf.projectId ? { projectId: sf.projectId } : {}),
    };
    const res = editingScheduleId.value
      ? await api.put<{ schedule: ChatSchedule }>(`/api/chat/schedules/${editingScheduleId.value}`, body)
      : await api.post<{ schedule: ChatSchedule }>('/api/chat/schedules', body);
    await loadSchedules();
    editingScheduleId.value = res.schedule.id;
  } catch (e) {
    scheduleError.value = e instanceof ApiError ? e.message : 'Could not save the task.';
  } finally {
    savingSchedule.value = false;
  }
}
async function deleteSchedule(s: ChatSchedule) {
  if (!confirm(`Delete scheduled task “${s.name}”?`)) return;
  try {
    await api.del(`/api/chat/schedules/${s.id}`);
  } catch (e) {
    alert(e instanceof ApiError ? e.message : 'Could not delete the task — please try again.');
    return;
  }
  schedules.value = schedules.value.filter((x) => x.id !== s.id);
  if (editingScheduleId.value === s.id) scheduleView.value = false;
}
async function toggleSchedule(s: ChatSchedule) {
  const res = await api.put<{ schedule: ChatSchedule }>(`/api/chat/schedules/${s.id}`, { enabled: !s.enabled });
  const i = schedules.value.findIndex((x) => x.id === s.id);
  if (i >= 0) schedules.value[i] = res.schedule;
}

// ── Personal prompt library ─────────────────────────────────────────────────
const prompts = ref<ChatUserPrompt[]>([]);
const showPrompts = ref(false);
const promptEditing = ref(false);
const editingPromptId = ref<string | null>(null);
const pform = reactive({ name: '', content: '' });
async function loadPrompts() {
  prompts.value = (await api.get<{ prompts: ChatUserPrompt[] }>('/api/chat/prompts')).prompts;
}
function openPrompts() {
  promptEditing.value = false;
  editingPromptId.value = null;
  showPrompts.value = true;
  loadPrompts();
}
function usePrompt(p: ChatUserPrompt) {
  input.value = input.value.trim() ? `${input.value}\n${p.content}` : p.content;
  showPrompts.value = false;
}
function newPrompt() {
  editingPromptId.value = null;
  pform.name = '';
  pform.content = input.value || '';
  promptEditing.value = true;
}
function editPrompt(p: ChatUserPrompt) {
  editingPromptId.value = p.id;
  pform.name = p.name;
  pform.content = p.content;
  promptEditing.value = true;
}
async function savePrompt() {
  if (!pform.name.trim() || !pform.content.trim()) return;
  const body = { name: pform.name.trim(), content: pform.content };
  try {
    if (editingPromptId.value) await api.put(`/api/chat/prompts/${editingPromptId.value}`, body);
    else await api.post('/api/chat/prompts', body);
    await loadPrompts();
    promptEditing.value = false;
  } catch {
    /* ignore */
  }
}
async function deletePrompt(p: ChatUserPrompt) {
  if (!confirm(`Delete prompt “${p.name}”?`)) return;
  await api.del(`/api/chat/prompts/${p.id}`);
  prompts.value = prompts.value.filter((x) => x.id !== p.id);
}

// ── Persistent memory (per-user durable facts) ────────────────────────────
const memory = ref<ChatMemory[]>([]);
const showMemory = ref(false);
const memoryDraft = ref('');
const savingMemory = ref(false);
async function loadMemory() {
  memory.value = (await api.get<{ memory: ChatMemory[] }>('/api/chat/memory')).memory;
}
function openMemory() {
  showMemory.value = true;
  memoryDraft.value = '';
  loadMemory();
}
async function addMemory() {
  const content = memoryDraft.value.trim();
  if (!content || savingMemory.value) return;
  savingMemory.value = true;
  try {
    const { item } = await api.post<{ item: ChatMemory }>('/api/chat/memory', { content });
    memory.value.push(item);
    memoryDraft.value = '';
  } finally {
    savingMemory.value = false;
  }
}
async function deleteMemory(m: ChatMemory) {
  await api.del(`/api/chat/memory/${m.id}`);
  memory.value = memory.value.filter((x) => x.id !== m.id);
}

// ── Assistant presets ─────────────────────────────────────────────────────
const assistants = ref<ChatAssistant[]>([]);
const currentAssistant = computed(() =>
  current.value?.assistantId ? assistants.value.find((a) => a.id === current.value!.assistantId) : undefined,
);
const showAssistants = ref(false);
const assistantEditing = ref(false);
const editingAssistantId = ref<string | null>(null);
const af = reactive({ name: '', instructions: '', providerId: '', model: '', vserverSlug: '' });
async function loadAssistants() {
  assistants.value = (await api.get<{ assistants: ChatAssistant[] }>('/api/chat/assistants')).assistants;
}
function openAssistants() {
  assistantEditing.value = false;
  editingAssistantId.value = null;
  showAssistants.value = true;
  loadAssistants();
}
function newAssistant() {
  editingAssistantId.value = null;
  af.name = '';
  af.instructions = '';
  af.providerId = providers.value[0]?.id ?? '';
  af.model = providers.value[0]?.defaultModel ?? providers.value[0]?.models[0] ?? '';
  af.vserverSlug = '';
  assistantEditing.value = true;
}
function editAssistant(a: ChatAssistant) {
  editingAssistantId.value = a.id;
  af.name = a.name;
  af.instructions = a.instructions;
  af.providerId = a.providerId;
  af.model = a.model;
  af.vserverSlug = a.vserverSlug;
  assistantEditing.value = true;
}
function onAssistantFormProvider() {
  const p = providers.value.find((x) => x.id === af.providerId);
  af.model = p?.defaultModel ?? p?.models[0] ?? '';
}
async function saveAssistant() {
  if (!af.name.trim()) return;
  const body = { name: af.name.trim(), instructions: af.instructions, providerId: af.providerId, model: af.model, vserverSlug: af.vserverSlug };
  if (editingAssistantId.value) await api.put(`/api/chat/assistants/${editingAssistantId.value}`, body);
  else await api.post('/api/chat/assistants', body);
  await loadAssistants();
  assistantEditing.value = false;
}
async function deleteAssistant(a: ChatAssistant) {
  if (!confirm(`Delete assistant “${a.name}”?`)) return;
  await api.del(`/api/chat/assistants/${a.id}`);
  assistants.value = assistants.value.filter((x) => x.id !== a.id);
}

function openNew(projectId = '') {
  newError.value = '';
  nc.assistantId = '';
  nc.providerId = providers.value[0]?.id ?? '';
  nc.model = providers.value[0]?.defaultModel ?? providers.value[0]?.models[0] ?? '';
  nc.vserverSlug = '';
  nc.projectId = projectId;
  showNew.value = true;
}
function onProviderChange() {
  const p = providers.value.find((x) => x.id === nc.providerId);
  nc.model = p?.defaultModel ?? p?.models[0] ?? '';
}
// Picking an assistant pre-fills the chat's model + tools from the preset (the user can still tweak them).
function onAssistantChange() {
  const a = assistants.value.find((x) => x.id === nc.assistantId);
  if (!a) return;
  if (a.providerId && providers.value.some((p) => p.id === a.providerId)) {
    nc.providerId = a.providerId;
    nc.model = a.model || providers.value.find((p) => p.id === a.providerId)?.defaultModel || nc.model;
  }
  if (a.vserverSlug) nc.vserverSlug = a.vserverSlug;
}
async function createConversation() {
  newError.value = '';
  if (!nc.providerId || !nc.model) {
    newError.value = 'Pick a provider and model.';
    return;
  }
  try {
    const res = await api.post<{ conversation: ChatConversation }>('/api/chat/conversations', {
      title: 'New chat',
      providerId: nc.providerId,
      model: nc.model,
      vserverSlug: nc.vserverSlug,
      ...(nc.assistantId ? { assistantId: nc.assistantId } : {}),
      ...(nc.projectId ? { projectId: nc.projectId } : {}),
    });
    showNew.value = false;
    conversations.value.unshift(res.conversation);
    if (project.value && nc.projectId === project.value.project.id) project.value.conversations.unshift(res.conversation);
    project.value = null;
    current.value = res.conversation;
    messages.value = [];
  } catch (e) {
    newError.value = e instanceof ApiError ? e.message : 'Could not create chat.';
  }
}

function triggerPick() {
  fileInput.value?.click();
}
async function uploadFiles(files: File[]) {
  const conv = current.value; // capture: the user may switch conversations while the upload is in flight
  if (!conv || files.length === 0) return;
  uploading.value = true;
  try {
    for (const f of files) {
      try {
        const res = await api.upload<{ attachment: ChatAttachment }>(`/api/chat/conversations/${conv.id}/attachments`, f);
        if (current.value?.id === conv.id) pending.value.push(res.attachment); // discard if the user navigated away
      } catch (err) {
        if (current.value?.id === conv.id) {
          messages.value.push({ id: 'err-' + Date.now(), conversationId: conv.id, role: 'assistant', content: `⚠️ ${f.name}: ${err instanceof ApiError ? err.message : 'upload failed'}`, createdAt: new Date().toISOString() });
        }
      }
    }
  } finally {
    uploading.value = false;
  }
}
async function onFilesSelected(e: Event) {
  const el = e.target as HTMLInputElement;
  const files = Array.from(el.files ?? []);
  el.value = ''; // allow re-selecting the same file
  await uploadFiles(files);
}
// Drag & drop files onto the composer (no need to click the 📎 button).
const dragOver = ref(false);
async function onDrop(e: DragEvent) {
  dragOver.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) await uploadFiles(files);
}
function removePending(a: ChatAttachment) {
  pending.value = pending.value.filter((x) => x.id !== a.id);
}

async function send() {
  if (!current.value || sending.value || uploading.value) return;
  const text = input.value.trim() || (pending.value.length ? 'Please review the attached file(s).' : '');
  if (!text) return;
  const conv = current.value; // capture: guard against a mid-send conversation switch
  input.value = '';
  const tmpId = 'tmp-' + Date.now();
  messages.value.push({ id: tmpId, conversationId: conv.id, role: 'user', content: text, createdAt: new Date().toISOString() });
  // Show staged files under the optimistic user message, then clear the composer tray.
  const attIds = pending.value.map((a) => a.id);
  for (const a of pending.value) attachments.value.push({ ...a, messageId: tmpId });
  pending.value = [];
  sending.value = true;
  scrollDown();
  try {
    const res = await api.post<{ message: ChatMessage; attachments?: ChatAttachment[] }>(`/api/chat/conversations/${conv.id}/messages`, { content: text, attachmentIds: attIds });
    if (current.value?.id === conv.id) {
      messages.value.push(res.message);
      for (const a of res.attachments ?? []) attachments.value.push(a); // show interpreter-produced downloads immediately
    }
  } catch (e) {
    if (current.value?.id === conv.id) {
      messages.value.push({ id: 'err-' + Date.now(), conversationId: conv.id, role: 'assistant', content: `⚠️ ${e instanceof ApiError ? e.message : 'Failed to get a reply.'}`, createdAt: new Date().toISOString() });
    }
  } finally {
    sending.value = false;
    scrollDown();
  }
}

async function logout() {
  await auth.logout();
  router.push('/login');
}
</script>

<template>
  <div class="chat-shell">
    <aside class="chat-sidebar">
      <div class="brand"><RavenLogo :size="24" /> {{ auth.info?.instanceName || 'Kravn' }}</div>
      <div style="padding: 10px">
        <button class="btn primary" style="width: 100%" @click="openNew()">+ New chat</button>
        <input v-model="chatSearch" class="chat-search" placeholder="Search chats…" />
      </div>
      <div class="convs">
        <div class="side-section">
          <span>Projects</span>
          <button class="add" title="New project" @click="openNewProject">+</button>
        </div>
        <div v-if="projects.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">No projects yet.</div>
        <div
          v-for="p in projects"
          :key="p.id"
          class="conv-item"
          :class="{ active: project?.project.id === p.id }"
          @click="openProject(p)"
        >
          📁 {{ p.name }}
          <small v-if="p.access && p.access !== 'owner'" class="muted" style="display: block; font-size: 11px">shared · {{ p.ownerEmail }}</small>
        </div>

        <div class="side-section" style="margin-top: 6px"><span>Chats</span></div>
        <div v-if="allTags.length" class="tag-bar">
          <button
            v-for="t in allTags"
            :key="t"
            class="tag-chip"
            :class="{ active: activeTag?.toLowerCase() === t.toLowerCase() }"
            @click="toggleTagFilter(t)"
          >{{ t }}</button>
        </div>
        <div v-if="conversations.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">No chats yet.</div>
        <div v-else-if="filteredConversations.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">No chats match your filter.</div>
        <div
          v-for="c in filteredConversations"
          :key="c.id"
          class="conv-item conv-row"
          :class="{ active: current?.id === c.id }"
          @click="open(c)"
        >
          <span class="conv-item-title">{{ c.title || 'New chat' }}</span>
          <button class="conv-del" title="Delete chat" @click.stop="deleteConversation(c)">🗑</button>
        </div>

        <div class="side-section" style="margin-top: 6px">
          <span>Scheduled</span>
          <button class="add" title="New scheduled task" @click="openScheduleNew">+</button>
        </div>
        <div v-if="schedules.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">No scheduled tasks.</div>
        <div
          v-for="s in schedules"
          :key="s.id"
          class="conv-item conv-row"
          :class="{ active: scheduleView && editingScheduleId === s.id }"
          @click="openSchedule(s)"
        >
          <span class="conv-item-title">⏱ {{ s.name }}<span v-if="!s.enabled" class="muted"> · paused</span></span>
          <button class="conv-del" title="Delete task" @click.stop="deleteSchedule(s)">🗑</button>
        </div>
      </div>
      <div class="foot">
        <small class="muted">{{ auth.user?.email }}</small>
        <button class="btn" @click="logout">Sign out</button>
      </div>
    </aside>

    <main class="chat-main">
      <!-- Conversation thread -->
      <template v-if="current">
        <div class="chat-head">
          <input
            v-if="editingTitle"
            ref="titleInput"
            v-model="titleDraft"
            class="title-input"
            maxlength="200"
            @keydown.enter.prevent="saveTitle"
            @keydown.esc.prevent="cancelRenameTitle"
            @blur="saveTitle"
          />
          <span v-else class="chat-title" title="Click to rename" @click="startRenameTitle">{{ current.title || 'New chat' }}</span>
          <span class="chat-head-right">
            <small v-if="currentAssistant" class="muted">🤖 {{ currentAssistant.name }} · </small>
            <small class="muted">{{ current.model }}<span v-if="current.vserverSlug"> · tools: {{ current.vserverSlug }}</span></small>
            <button class="conv-del head-del" title="Delete chat" @click="deleteConversation(current)">🗑</button>
          </span>
        </div>
        <div class="chat-tags">
          <span v-for="t in (current.tags ?? [])" :key="t" class="tag-chip static">
            {{ t }}<button class="tag-x" title="Remove tag" @click="removeTag(t)">×</button>
          </span>
          <input
            v-model="tagDraft"
            class="tag-input"
            maxlength="40"
            placeholder="+ tag"
            @keydown.enter.prevent="addTag"
            @blur="addTag"
          />
        </div>
        <div ref="thread" class="chat-thread">
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
            <div>
              <!-- Assistant replies are markdown → rendered HTML (safe: markdown-it html:false escapes any
                   raw markup). User messages stay plain text. -->
              <div v-if="m.role === 'assistant'" class="bubble md" v-html="renderMarkdown(m.content)"></div>
              <div v-else class="bubble">{{ m.content }}</div>
              <div v-if="attachmentsFor(m.id).length" class="msg-atts">
                <button
                  v-for="a in attachmentsFor(m.id)"
                  :key="a.id"
                  class="att-chip att-dl"
                  :title="`Download ${a.name}`"
                  @click="downloadAttachment(a)"
                >
                  📎 {{ a.name }} <small class="muted">{{ fmtSize(a.size) }}</small> <span class="dl-icon">⬇</span>
                </button>
              </div>
            </div>
          </div>
          <div v-if="sending" class="msg assistant"><div class="bubble muted">Thinking…</div></div>
        </div>
        <div
          class="composer-wrap"
          :class="{ dragging: dragOver }"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <div v-if="dragOver" class="drop-hint">Drop files to attach</div>
          <div v-if="pending.length || uploading" class="att-tray">
            <span v-for="a in pending" :key="a.id" class="att-chip">
              📎 {{ a.name }} <small class="muted">{{ fmtSize(a.size) }}{{ a.textChars ? '' : ' · no text' }}</small>
              <button class="att-x" title="Remove" @click="removePending(a)">×</button>
            </span>
            <span v-if="uploading" class="muted" style="font-size: 12px">Uploading…</span>
          </div>
          <div class="composer">
            <input ref="fileInput" type="file" multiple style="display: none"
              accept=".pdf,.doc,.docx,.txt,.md,.csv,.tsv,.xlsx,.xls,.json,.log,.yaml,.yml,.xml,.html,.png,.jpg,.jpeg,.webp,.gif"
              @change="onFilesSelected" />
            <button class="btn" title="Attach files" :disabled="uploading" @click="triggerPick">📎</button>
            <button class="btn" title="Prompt library" @click="openPrompts">📋</button>
            <button class="btn" title="Memory — what the assistant always remembers" @click="openMemory">🧠</button>
            <textarea v-model="input" rows="2" placeholder="Message…  (attach or drag files — PDF, Word, Excel/CSV, text, images)" @keydown.enter.exact.prevent="send"></textarea>
            <button class="btn primary" :disabled="sending || uploading || (!input.trim() && pending.length === 0)" @click="send">Send</button>
          </div>
        </div>
      </template>

      <!-- Project panel -->
      <div v-else-if="project" class="project-panel">
        <div class="chat-head" style="padding: 0 0 0.75rem; border-bottom: 1px solid var(--border)">
          <span>📁 {{ project.project.name }}
            <small v-if="project.project.access !== 'owner'" class="muted" style="font-size: 12px">· {{ project.project.access }} · shared by {{ project.project.ownerEmail }}</small>
          </span>
          <div class="btn-row">
            <button class="btn primary" @click="openNew(project.project.id)">+ New chat in project</button>
            <button v-if="isOwner" class="btn" @click="deleteProject(project.project)">Delete</button>
          </div>
        </div>

        <div class="panel-card">
          <h3>Project instructions</h3>
          <p class="muted" style="margin: 0; font-size: 12px">Prepended to every chat started in this project.</p>
          <textarea v-model="project.project.instructions" rows="5" :readonly="!canEdit" placeholder="e.g. You are a compliance assistant. Always cite the source document."></textarea>
          <div v-if="canEdit" class="btn-row" style="justify-content: flex-end">
            <button class="btn primary" :disabled="savingInstr" @click="saveInstructions">{{ savingInstr ? 'Saving…' : 'Save instructions' }}</button>
          </div>
        </div>

        <div class="panel-card">
          <h3>Documents <span class="muted" style="font-weight: 400">({{ project.documents.length }})</span></h3>
          <p class="muted" style="margin: 0; font-size: 12px">Their text is injected as reference context when the assistant answers.</p>
          <div v-if="project.documents.length === 0" class="muted" style="font-size: 13px">No documents yet.</div>
          <div v-for="d in project.documents" :key="d.id" class="doc-item">
            <span>📄 {{ d.name }}</span>
            <span class="row" style="gap: 0.6rem; align-items: center">
              <span class="doc-meta">{{ Math.ceil(d.size / 1024) }} KB</span>
              <button v-if="canEdit" class="btn" @click="deleteDocument(d)">Remove</button>
            </span>
          </div>
          <template v-if="canEdit">
            <hr style="border: none; border-top: 1px solid var(--border); margin: 0.4rem 0" />
            <div class="field"><label>Add document</label><input v-model="newDoc.name" placeholder="Document name (e.g. policy.md)" /></div>
            <textarea v-model="newDoc.content" rows="4" placeholder="Paste the document text…"></textarea>
            <div class="btn-row" style="justify-content: flex-end">
              <button class="btn primary" :disabled="docBusy || !newDoc.name.trim() || !newDoc.content.trim()" @click="addDocument">{{ docBusy ? 'Adding…' : 'Add document' }}</button>
            </div>
          </template>
        </div>

        <!-- Sharing (owner only) -->
        <div v-if="isOwner" class="panel-card">
          <h3>Sharing <span class="muted" style="font-weight: 400">({{ project.members.length }})</span></h3>
          <p class="muted" style="margin: 0; font-size: 12px">Give another Kravn user access to this project's instructions and documents.</p>
          <div v-if="project.members.length === 0" class="muted" style="font-size: 13px">Not shared with anyone yet.</div>
          <div v-for="m in project.members" :key="m.userId" class="doc-item">
            <span>👤 {{ m.email }}</span>
            <span class="row" style="gap: 0.6rem; align-items: center">
              <span class="doc-meta">{{ m.role }}</span>
              <button class="btn" @click="unshareMember(m)">Remove</button>
            </span>
          </div>
          <hr style="border: none; border-top: 1px solid var(--border); margin: 0.4rem 0" />
          <div class="row" style="gap: 0.5rem; align-items: flex-end; flex-wrap: wrap">
            <div class="field" style="flex: 1; min-width: 180px"><label>Share with (email)</label><input v-model="share.email" placeholder="user@company.com" @keydown.enter.prevent="shareProject" /></div>
            <div class="field"><label>Role</label>
              <select v-model="share.role"><option value="viewer">Viewer</option><option value="editor">Editor</option></select>
            </div>
            <button class="btn primary" :disabled="sharing || !share.email.trim()" @click="shareProject">{{ sharing ? 'Sharing…' : 'Share' }}</button>
          </div>
          <p v-if="shareError" class="muted" style="color: #e5484d; font-size: 12px; margin: 0.3rem 0 0">{{ shareError }}</p>
        </div>

        <div class="panel-card" v-if="project.conversations.length">
          <h3>Chats in this project</h3>
          <div v-for="c in project.conversations" :key="c.id" class="conv-item" @click="open(c)">{{ c.title || 'New chat' }}</div>
        </div>
      </div>

      <!-- Empty -->
      <!-- Scheduled task editor -->
      <div v-else-if="scheduleView" class="project-panel">
        <div class="chat-head" style="padding: 0 0 0.75rem; border-bottom: 1px solid var(--border)">
          <span>⏱ {{ editingScheduleId ? 'Edit scheduled task' : 'New scheduled task' }}</span>
        </div>

        <div class="panel-card">
          <div class="field"><label>Name</label><input v-model="sf.name" placeholder="e.g. Daily incident summary" /></div>
          <div class="field"><label>Prompt (what to run)</label><textarea v-model="sf.prompt" rows="4" placeholder="e.g. Summarize yesterday's incidents and list the top 3 risks."></textarea></div>
          <div class="row" style="gap: 0.5rem; flex-wrap: wrap">
            <div class="field" style="flex: 1; min-width: 150px"><label>Provider</label>
              <select v-model="sf.providerId" @change="onScheduleProviderChange">
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <div class="field" style="flex: 1; min-width: 150px"><label>Model</label>
              <input v-model="sf.model" list="sched-models" placeholder="model" />
              <datalist id="sched-models"><option v-for="m in (providers.find((p) => p.id === sf.providerId)?.models ?? [])" :key="m" :value="m" /></datalist>
            </div>
          </div>
          <div class="row" style="gap: 0.5rem; flex-wrap: wrap">
            <div class="field" style="flex: 1; min-width: 150px"><label>Tools (MCP endpoint)</label>
              <select v-model="sf.vserverSlug">
                <option value="">None</option>
                <option v-for="v in vservers" :key="v.slug" :value="v.slug">{{ v.name }}</option>
              </select>
            </div>
            <div class="field" style="flex: 1; min-width: 150px"><label>Project (context)</label>
              <select v-model="sf.projectId">
                <option value="">None</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="panel-card">
          <h3>When</h3>
          <div class="row" style="gap: 1rem">
            <label class="row" style="gap: 0.3rem; align-items: center"><input type="radio" value="cron" v-model="sf.kind" /> Recurring (cron)</label>
            <label class="row" style="gap: 0.3rem; align-items: center"><input type="radio" value="once" v-model="sf.kind" /> Once</label>
          </div>
          <div v-if="sf.kind === 'cron'" class="field"><label>Cron expression</label>
            <input v-model="sf.cron" placeholder="0 9 * * 1" />
            <small class="muted">5 fields: min hour day-of-month month day-of-week. E.g. <code>*/30 * * * *</code> = every 30 min · <code>0 9 * * 1</code> = 9am Mondays.</small>
          </div>
          <div v-else class="field"><label>Run at</label><input v-model="sf.runAt" type="datetime-local" /></div>
          <div class="field"><label>Timezone</label><input v-model="sf.timezone" placeholder="UTC" /></div>
          <label class="row" style="gap: 0.4rem; align-items: center; margin-top: 0.3rem"><input type="checkbox" v-model="sf.enabled" /> Enabled</label>
        </div>

        <p v-if="scheduleError" class="muted" style="color: #e5484d; font-size: 12px">{{ scheduleError }}</p>
        <div class="btn-row" style="justify-content: space-between">
          <button v-if="scheduleById(editingScheduleId)" class="btn" @click="deleteSchedule(scheduleById(editingScheduleId)!)">Delete</button>
          <span></span>
          <button class="btn primary" :disabled="savingSchedule" @click="saveSchedule">{{ savingSchedule ? 'Saving…' : 'Save task' }}</button>
        </div>

        <div v-if="scheduleById(editingScheduleId)" class="panel-card">
          <h3>Status</h3>
          <div class="muted" style="font-size: 13px; display: flex; flex-direction: column; gap: 2px">
            <span>Next run: {{ scheduleById(editingScheduleId)?.nextRunAt || (scheduleById(editingScheduleId)?.enabled ? '—' : 'paused') }}</span>
            <span v-if="scheduleById(editingScheduleId)?.lastRunAt">Last run: {{ scheduleById(editingScheduleId)?.lastRunAt }} · {{ scheduleById(editingScheduleId)?.lastStatus }}</span>
            <span v-if="scheduleById(editingScheduleId)?.lastError" style="color: #e5484d">{{ scheduleById(editingScheduleId)?.lastError }}</span>
          </div>
        </div>
      </div>

      <div v-else class="chat-empty">
        <RavenLogo :size="48" />
        <p>Start a new chat, or open a project to give the assistant instructions and documents.</p>
        <div class="btn-row">
          <button class="btn primary" @click="openNew()">+ New chat</button>
          <button class="btn" @click="openNewProject">+ New project</button>
        </div>
      </div>
    </main>

    <!-- New chat modal -->
    <div v-if="showNew" class="modal-backdrop" @click.self="showNew = false">
      <div class="modal">
        <h2>New chat</h2>
        <div v-if="newError" class="alert error">{{ newError }}</div>
        <div v-if="providers.length === 0" class="alert error">
          No LLM providers are configured. Ask an admin to add one in the operator console.
        </div>
        <div class="field">
          <label style="display: flex; justify-content: space-between; align-items: center">
            <span>Assistant (optional)</span>
            <a href="#" style="font-size: 12px" @click.prevent="openAssistants">Manage…</a>
          </label>
          <select v-model="nc.assistantId" @change="onAssistantChange">
            <option value="">No assistant</option>
            <option v-for="a in assistants" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
          <small class="muted">An assistant pre-fills the model + tools and adds its instructions to the chat.</small>
        </div>
        <div class="field">
          <label>Model provider</label>
          <select v-model="nc.providerId" @change="onProviderChange">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>Model</label>
          <input v-model="nc.model" list="model-list" placeholder="gpt-4o-mini" />
          <datalist id="model-list">
            <option v-for="m in providers.find((p) => p.id === nc.providerId)?.models ?? []" :key="m" :value="m" />
          </datalist>
        </div>
        <div class="field">
          <label>Tools (optional)</label>
          <select v-model="nc.vserverSlug">
            <option value="">No tools</option>
            <option v-for="v in vservers" :key="v.slug" :value="v.slug">{{ v.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>Project (optional)</label>
          <select v-model="nc.projectId">
            <option value="">No project</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <small class="muted">A project adds its instructions and documents as context.</small>
        </div>
        <div class="btn-row" style="justify-content: flex-end">
          <button class="btn" @click="showNew = false">Cancel</button>
          <button class="btn primary" :disabled="providers.length === 0" @click="createConversation">Create</button>
        </div>
      </div>
    </div>

    <!-- New project modal -->
    <div v-if="showNewProject" class="modal-backdrop" @click.self="showNewProject = false">
      <div class="modal">
        <h2>New project</h2>
        <div v-if="projectError" class="alert error">{{ projectError }}</div>
        <div class="field"><label>Name</label><input v-model="np.name" placeholder="e.g. Q3 Compliance" autofocus /></div>
        <div class="field">
          <label>Instructions (optional)</label>
          <textarea v-model="np.instructions" rows="4" placeholder="System instructions for every chat in this project…"></textarea>
        </div>
        <div class="btn-row" style="justify-content: flex-end">
          <button class="btn" @click="showNewProject = false">Cancel</button>
          <button class="btn primary" @click="createProject">Create</button>
        </div>
      </div>
    </div>

    <!-- Prompt library -->
    <div v-if="showPrompts" class="modal-backdrop" @click.self="showPrompts = false">
      <div class="modal">
        <div class="btn-row" style="justify-content: space-between; align-items: center">
          <h2 style="margin: 0">{{ promptEditing ? (editingPromptId ? 'Edit prompt' : 'New prompt') : 'Prompt library' }}</h2>
          <button v-if="!promptEditing" class="btn primary" @click="newPrompt">+ New</button>
        </div>
        <template v-if="!promptEditing">
          <p class="muted" style="font-size: 12px; margin: 0.2rem 0">Your saved prompts. Click Use to drop one into the message box; you can also create a custom prompt any time.</p>
          <div v-if="prompts.length === 0" class="muted" style="font-size: 13px; padding: 0.5rem 0">No saved prompts yet — create one with “+ New”.</div>
          <div v-for="p in prompts" :key="p.id" class="doc-item">
            <span class="conv-item-title">📋 {{ p.name }}</span>
            <span class="row" style="gap: 0.4rem; align-items: center">
              <button class="btn" @click="usePrompt(p)">Use</button>
              <button class="btn" @click="editPrompt(p)">Edit</button>
              <button class="btn" title="Delete" @click="deletePrompt(p)">🗑</button>
            </span>
          </div>
          <div class="btn-row" style="justify-content: flex-end; margin-top: 0.5rem">
            <button class="btn" @click="showPrompts = false">Close</button>
          </div>
        </template>
        <template v-else>
          <div class="field"><label>Name</label><input v-model="pform.name" placeholder="e.g. Weekly report" autofocus /></div>
          <div class="field"><label>Prompt</label><textarea v-model="pform.content" rows="6" placeholder="The prompt text…"></textarea></div>
          <div class="btn-row" style="justify-content: flex-end">
            <button class="btn" @click="promptEditing = false">Back</button>
            <button class="btn primary" :disabled="!pform.name.trim() || !pform.content.trim()" @click="savePrompt">Save</button>
          </div>
        </template>
      </div>
    </div>

    <!-- Persistent memory -->
    <div v-if="showMemory" class="modal-backdrop" @click.self="showMemory = false">
      <div class="modal">
        <h2 style="margin: 0 0 0.2rem">Memory</h2>
        <p class="muted" style="font-size: 12px; margin: 0.2rem 0">
          Facts you add here are given to the assistant at the start of every chat. You control exactly what is
          remembered — nothing is captured automatically.
        </p>
        <div v-if="memory.length === 0" class="muted" style="font-size: 13px; padding: 0.5rem 0">No memories yet.</div>
        <div v-for="m in memory" :key="m.id" class="doc-item">
          <span class="conv-item-title" style="white-space: normal">🧠 {{ m.content }}</span>
          <button class="btn" title="Forget" @click="deleteMemory(m)">🗑</button>
        </div>
        <div class="field" style="margin-top: 0.5rem">
          <label>Add a memory</label>
          <textarea v-model="memoryDraft" rows="2" maxlength="2000" placeholder="e.g. I manage the AML compliance team; always answer in Spanish." @keydown.enter.exact.prevent="addMemory"></textarea>
        </div>
        <div class="btn-row" style="justify-content: flex-end">
          <button class="btn" @click="showMemory = false">Close</button>
          <button class="btn primary" :disabled="!memoryDraft.trim() || savingMemory" @click="addMemory">Add</button>
        </div>
      </div>
    </div>

    <!-- Assistants -->
    <div v-if="showAssistants" class="modal-backdrop" @click.self="showAssistants = false">
      <div class="modal">
        <div class="btn-row" style="justify-content: space-between; align-items: center">
          <h2 style="margin: 0">{{ assistantEditing ? (editingAssistantId ? 'Edit assistant' : 'New assistant') : 'Assistants' }}</h2>
          <button v-if="!assistantEditing" class="btn primary" @click="newAssistant">+ New</button>
        </div>
        <template v-if="!assistantEditing">
          <p class="muted" style="font-size: 12px; margin: 0.2rem 0">Reusable presets — a persona (instructions) plus a default model and tools. Pick one when you start a chat.</p>
          <div v-if="assistants.length === 0" class="muted" style="font-size: 13px; padding: 0.5rem 0">No assistants yet — create one with “+ New”.</div>
          <div v-for="a in assistants" :key="a.id" class="doc-item">
            <span class="conv-item-title">🤖 {{ a.name }}</span>
            <span class="row" style="gap: 0.4rem; align-items: center">
              <button class="btn" @click="editAssistant(a)">Edit</button>
              <button class="btn" title="Delete" @click="deleteAssistant(a)">🗑</button>
            </span>
          </div>
          <div class="btn-row" style="justify-content: flex-end; margin-top: 0.5rem">
            <button class="btn" @click="showAssistants = false">Close</button>
          </div>
        </template>
        <template v-else>
          <div class="field"><label>Name</label><input v-model="af.name" placeholder="e.g. Compliance analyst" autofocus /></div>
          <div class="field"><label>Instructions</label><textarea v-model="af.instructions" rows="5" placeholder="How this assistant should behave — persona, tone, rules…"></textarea></div>
          <div class="field">
            <label>Model provider</label>
            <select v-model="af.providerId" @change="onAssistantFormProvider">
              <option value="">Chat default</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </div>
          <div class="field" v-if="af.providerId">
            <label>Model</label>
            <input v-model="af.model" list="assistant-model-list" placeholder="gpt-4o-mini" />
            <datalist id="assistant-model-list">
              <option v-for="m in providers.find((p) => p.id === af.providerId)?.models ?? []" :key="m" :value="m" />
            </datalist>
          </div>
          <div class="field">
            <label>Tools (optional)</label>
            <select v-model="af.vserverSlug">
              <option value="">No tools</option>
              <option v-for="v in vservers" :key="v.slug" :value="v.slug">{{ v.name }}</option>
            </select>
          </div>
          <div class="btn-row" style="justify-content: flex-end">
            <button class="btn" @click="assistantEditing = false">Back</button>
            <button class="btn primary" :disabled="!af.name.trim()" @click="saveAssistant">Save</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
