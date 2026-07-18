<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter, useRoute } from 'vue-router';
import type { ChatConversation, ChatMessage, ChatProject, ChatProjectDocument, ChatAttachment, ProjectMember, ChatSchedule, ChatUserPrompt, ChatMemory, ChatAgent, AvailableTool } from '@kravn/contracts';
import { api, ApiError, postSse } from '../api';
import { shouldShowAttribution } from '@kravn/contracts';
import { useAuthStore } from '../stores/auth';
import { renderMarkdown } from '../lib/markdown';
import BrandLogo from '../BrandLogo.vue';
import PoweredByKravn from '../PoweredByKravn.vue';
import LocaleSwitcher from '../LocaleSwitcher.vue';
import GroupedSelect, { type GroupedItem, type GroupMeta } from '../GroupedSelect.vue';
import {
  Folder, MoreHorizontal, Pencil, Settings, Trash2, Bot, Pin, ChevronRight, ChevronDown,
  Ban, Archive, ArchiveRestore, Globe, MessageSquare, Clock, FileText, User, Wrench,
  ClipboardList, Brain, Paperclip, Download, X, Plus, Check,
} from 'lucide-vue-next';

interface ProviderOpt { id: string; name: string; models: string[]; defaultModel: string }
interface VsOpt { slug: string; name: string }
interface ProjectDetail { project: ChatProject; documents: ChatProjectDocument[]; conversations: ChatConversation[]; members: ProjectMember[] }

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const brandName = computed(() => auth.info?.branding?.brandName || auth.info?.instanceName || 'Kravn');
const brandCustomized = computed(() => shouldShowAttribution(auth.info?.branding, auth.info?.instanceName));

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
    if (q && !(c.title || t('chat.newChat')).toLowerCase().includes(q)) return false;
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

/** What the assistant is doing right now, streamed from the turn: its reasoning between rounds, and each tool
 *  as it runs (`ok` undefined = still running). Lives only while `sending` — the reply itself is the answer. */
type LiveStep = { kind: 'thinking' | 'tool'; text: string; ok?: boolean };
const liveSteps = ref<LiveStep[]>([]);

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
const showSettings = ref(false);
const nc = reactive({ agentId: '', providerId: '', model: '', vserverSlug: '', projectId: '' });
const newError = ref('');

// New-project modal
const showNewProject = ref(false);
const np = reactive({ name: '', instructions: '' });
const projectError = ref('');

// Project panel edit state
const savingInstr = ref(false);
const newDoc = reactive({ name: '', content: '' });
const docBusy = ref(false);
// Project view opens CHATS-first; settings (instructions/documents/tools/sharing) live behind a gear toggle.
const showProjectSettings = ref(false);
// Scheduled tasks that belong to the open project (schedules already carry a projectId).
const projectSchedules = computed(() => (project.value ? schedules.value.filter((s) => s.projectId === project.value!.project.id) : []));

// Project TOOLS: the flat list of tools the user is entitled to (across every MCP endpoint) — the project pins
// a subset that its chats/scheduled tasks are limited to. Governance stays server-side; this is just the picker.
const availableTools = ref<AvailableTool[]>([]);
const availableToolsLoaded = ref(false);
const selectedToolIds = ref<string[]>([]);
const savingTools = ref(false);
// Tree grouped by origin MCP SERVER (same shape as the operator's endpoint composer), listing only what the
// user is entitled to. groupId = serverId (fall back to endpoint when a tool has no server).
const toolItems = computed<GroupedItem[]>(() =>
  availableTools.value.map((a) => ({ id: a.id, groupId: a.serverId || a.endpointSlug, label: a.name, sublabel: a.description })),
);
const toolServerMeta = computed<Record<string, GroupMeta>>(() =>
  Object.fromEntries(availableTools.value.map((a) => [a.serverId || a.endpointSlug, { name: a.serverName || a.endpointName || a.endpointSlug }])),
);
async function loadAvailableTools() {
  if (availableToolsLoaded.value) return;
  try {
    availableTools.value = (await api.get<{ tools: AvailableTool[] }>('/api/chat/available-tools')).tools;
    availableToolsLoaded.value = true;
  } catch { /* no tools available */ }
}
async function saveProjectTools() {
  if (!project.value) return;
  savingTools.value = true;
  try {
    const res = await api.put<{ project: ChatProject }>(`/api/chat/projects/${project.value.project.id}`, { toolIds: [...selectedToolIds.value] });
    project.value.project = res.project;
    selectedToolIds.value = [...res.project.toolIds]; // server may have dropped unentitled ids
    const idx = projects.value.findIndex((p) => p.id === res.project.id);
    if (idx >= 0) projects.value[idx] = res.project;
  } catch { /* keep the form as-is on error */ } finally {
    savingTools.value = false;
  }
}
// A new chat started in a project that pins tools INHERITS them — the endpoint picker doesn't apply then.
const newChatUsesProjectTools = computed(() => {
  if (!nc.projectId) return false;
  return (projects.value.find((p) => p.id === nc.projectId)?.toolIds.length ?? 0) > 0;
});

// Sharing — the caller's access to the open project drives what they can do.
const isOwner = computed(() => project.value?.project.access === 'owner');
const canEdit = computed(() => project.value != null && project.value.project.access !== 'viewer'); // owner OR editor
const share = reactive({ email: '', role: 'viewer' as 'editor' | 'viewer' });
const sharing = ref(false);
const shareError = ref('');
// Directory of other Kravn users, for the share picker (a list to select, not a free-text email box).
const shareableUsers = ref<{ id: string; email: string; name: string }[]>([]);
const shareableUsersLoaded = ref(false);
async function loadShareableUsers() {
  if (shareableUsersLoaded.value) return;
  try {
    shareableUsers.value = (await api.get<{ users: { id: string; email: string; name: string }[] }>('/api/chat/shareable-users')).users;
    shareableUsersLoaded.value = true;
  } catch { /* directory unavailable → the picker just shows empty */ }
}
// Candidates = everyone not already a member of the open project.
const shareCandidates = computed(() => {
  const taken = new Set((project.value?.members ?? []).map((m) => m.email.toLowerCase()));
  return shareableUsers.value.filter((u) => !taken.has(u.email.toLowerCase()));
});
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
    shareError.value = e instanceof ApiError ? e.message : t('chat.couldNotShareProject');
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
  const [opts, convs, projs, scheds, ags] = await Promise.all([
    api.get<{ providers: ProviderOpt[]; mcpEndpoints: VsOpt[] }>('/api/chat/options'),
    api.get<{ conversations: ChatConversation[] }>('/api/chat/conversations'),
    api.get<{ projects: ChatProject[] }>('/api/chat/projects'),
    api.get<{ schedules: ChatSchedule[] }>('/api/chat/schedules'),
    api.get<{ agents: ClientAgent[] }>('/api/chat/agents'),
  ]);
  providers.value = opts.providers;
  vservers.value = opts.mcpEndpoints;
  conversations.value = convs.conversations;
  projects.value = projs.projects;
  schedules.value = scheds.schedules;
  agents.value = ags.agents;
}
async function loadSchedules() {
  schedules.value = (await api.get<{ schedules: ChatSchedule[] }>('/api/chat/schedules')).schedules;
}
// ── Deep linking ────────────────────────────────────────────────────────────
// Each open chat / project / scheduled task owns a URL, so a refresh (F5) or a shared link reopens it.
// syncUrl() pushes the URL to match the current view; applyRoute() opens whatever the URL points at
// (on first load and on browser back/forward). Both are guarded so they don't loop.
function syncUrl() {
  const target = current.value
    ? { name: 'chat-conversation', params: { id: current.value.id } }
    : project.value
      ? { name: 'chat-project', params: { id: project.value.project.id } }
      : scheduleView.value && editingScheduleId.value
        ? { name: 'chat-schedule', params: { id: editingScheduleId.value } }
        : { name: 'chat' };
  const curId = typeof route.params.id === 'string' ? route.params.id : undefined;
  if (route.name !== target.name || curId !== (target as { params?: { id?: string } }).params?.id) {
    void router.push(target);
  }
}
async function applyRoute() {
  const id = typeof route.params.id === 'string' ? route.params.id : undefined;
  try {
    if (route.name === 'chat-conversation' && id) {
      if (current.value?.id !== id) await open({ id } as ChatConversation);
    } else if (route.name === 'chat-project' && id) {
      if (project.value?.project.id !== id) await openProject({ id } as ChatProject);
    } else if (route.name === 'chat-schedule' && id) {
      if (!(scheduleView.value && editingScheduleId.value === id)) {
        const s = schedules.value.find((x) => x.id === id);
        if (s) openSchedule(s);
        else void router.replace({ name: 'chat' });
      }
    } else if (route.name === 'chat') {
      // Home ('/') — e.g. browser back from a chat: show the empty state.
      current.value = null;
      project.value = null;
      scheduleView.value = false;
    }
  } catch {
    // Stale/invalid id (deleted chat, bad link) → fall back to the home view.
    current.value = null;
    project.value = null;
    scheduleView.value = false;
    if (route.name !== 'chat') void router.replace({ name: 'chat' });
  }
}
onMounted(async () => {
  await load();
  await applyRoute();
});
// Browser back/forward (and any external URL change) re-syncs the view to the URL.
watch(() => route.fullPath, applyRoute);

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
  syncUrl();
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
  showProjectSettings.value = false; // always open CHATS-first
  const res = await api.get<ProjectDetail>(`/api/chat/projects/${p.id}`);
  project.value = res;
  selectedToolIds.value = [...res.project.toolIds];
  newDoc.name = '';
  newDoc.content = '';
  share.email = '';
  void loadAvailableTools();
  if (res.project.access === 'owner') void loadShareableUsers();
  syncUrl();
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
    projectError.value = t('chat.giveProjectName');
    return;
  }
  try {
    const res = await api.post<{ project: ChatProject }>('/api/chat/projects', { name: np.name.trim(), instructions: np.instructions });
    showNewProject.value = false;
    projects.value.push(res.project);
    await openProject(res.project);
  } catch (e) {
    projectError.value = e instanceof ApiError ? e.message : t('chat.couldNotCreateProject');
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
/** Every model across all providers (deduped) — a project isn't tied to one provider, so its default model is
 *  a plain model id that pre-fills a new chat's model regardless of which provider that chat picks. */
const allModels = computed<string[]>(() => {
  const set = new Set<string>();
  for (const p of providers.value) for (const m of p.models) set.add(m);
  const cur = project.value?.project.defaultModel;
  if (cur && !set.has(cur)) set.add(cur); // keep a custom/legacy value
  return [...set].sort();
});
const savingModel = ref(false);
async function saveDefaultModel() {
  if (!project.value) return;
  savingModel.value = true;
  try {
    const res = await api.put<{ project: ChatProject }>(`/api/chat/projects/${project.value.project.id}`, {
      defaultModel: project.value.project.defaultModel,
    });
    project.value.project = res.project;
    const idx = projects.value.findIndex((p) => p.id === res.project.id);
    if (idx >= 0) projects.value[idx] = res.project;
  } finally {
    savingModel.value = false;
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
  if (!confirm(t('chat.confirmDeleteChat', { title: c.title || t('chat.newChat') }))) return;
  try {
    await api.del(`/api/chat/conversations/${c.id}`);
  } catch (e) {
    // Any error means the server never confirmed the delete — keep the chat in the list.
    alert(e instanceof ApiError ? e.message : t('chat.couldNotDeleteChat'));
    return;
  }
  conversations.value = conversations.value.filter((x) => x.id !== c.id);
  archived.value = archived.value.filter((x) => x.id !== c.id);
  if (project.value) project.value.conversations = project.value.conversations.filter((x) => x.id !== c.id);
  if (current.value?.id === c.id) {
    current.value = null;
    messages.value = [];
    editingTitle.value = false;
    syncUrl();
  }
}

// ── Chat actions menu (rename / move to project / pin / archive / delete) ──
const menuFor = ref<string | null>(null);
const menuPos = ref({ x: 0, y: 0 });
const menuUp = ref(false);
const moveSubmenu = ref(false);
const archived = ref<ChatConversation[]>([]);
const showArchived = ref(false);
const archivedLoaded = ref(false);

function toggleMenu(c: ChatConversation, ev: MouseEvent) {
  moveSubmenu.value = false;
  if (menuFor.value === c.id) {
    menuFor.value = null;
    return;
  }
  // Fixed positioning (computed from the button) so the menu escapes the sidebar's scroll clipping.
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  const width = 200;
  const x = Math.min(r.right - width + 8, window.innerWidth - width - 8);
  menuUp.value = r.bottom > window.innerHeight - 260;
  menuPos.value = { x: Math.max(8, x), y: menuUp.value ? r.top - 8 : r.bottom + 4 };
  menuFor.value = c.id;
}
function closeMenu() {
  menuFor.value = null;
  moveSubmenu.value = false;
}
async function reloadConversations() {
  conversations.value = (await api.get<{ conversations: ChatConversation[] }>('/api/chat/conversations')).conversations;
}
async function loadArchived() {
  archived.value = (await api.get<{ conversations: ChatConversation[] }>('/api/chat/conversations?archived=1')).conversations;
  archivedLoaded.value = true;
}
async function toggleArchivedView() {
  showArchived.value = !showArchived.value;
  if (showArchived.value && !archivedLoaded.value) await loadArchived();
}
async function togglePin(c: ChatConversation) {
  closeMenu();
  const pinned = !c.pinned;
  try {
    await api.put(`/api/chat/conversations/${c.id}`, { pinned });
    if (current.value?.id === c.id) current.value.pinned = pinned;
    await reloadConversations(); // re-sort: pinned float to the top
  } catch (e) {
    alert(e instanceof ApiError ? e.message : t('chat.couldNotUpdateChat'));
  }
}
async function toggleArchive(c: ChatConversation) {
  closeMenu();
  const next = !c.archived;
  try {
    await api.put(`/api/chat/conversations/${c.id}`, { archived: next });
    await reloadConversations();
    if (archivedLoaded.value) await loadArchived();
    if (next && current.value?.id === c.id) {
      current.value = null;
      messages.value = [];
      syncUrl();
    }
  } catch (e) {
    alert(e instanceof ApiError ? e.message : t('chat.couldNotUpdateChat'));
  }
}
async function moveToProject(c: ChatConversation, projectId: string) {
  closeMenu();
  try {
    await api.put(`/api/chat/conversations/${c.id}`, { projectId: projectId || null });
    c.projectId = projectId || null;
    if (current.value?.id === c.id) current.value.projectId = projectId || null;
    // If the moved-into project is currently open, reflect the new chat under it.
    if (project.value && projectId && project.value.project.id === projectId && !project.value.conversations.some((x) => x.id === c.id)) {
      project.value.conversations.unshift(c);
    }
  } catch (e) {
    alert(e instanceof ApiError ? e.message : t('chat.couldNotMoveChat'));
  }
}
async function renameFromMenu(c: ChatConversation) {
  closeMenu();
  if (current.value?.id !== c.id) await open(c);
  await startRenameTitle();
}
function deleteFromMenu(c: ChatConversation) {
  closeMenu();
  deleteConversation(c);
}
async function deleteProject(p: ChatProject) {
  if (!confirm(t('chat.confirmDeleteProject', { name: p.name }))) return;
  await api.del(`/api/chat/projects/${p.id}`);
  projects.value = projects.value.filter((x) => x.id !== p.id);
  if (project.value?.project.id === p.id) project.value = null;
}

// ── Project actions menu (rename / configure / delete) — mirrors the per-chat menu ──
const projMenuFor = ref<string | null>(null);
const projMenuPos = ref({ x: 0, y: 0 });
const projMenuUp = ref(false);
const renamingProjectId = ref<string | null>(null);
const projRenameDraft = ref('');

function toggleProjMenu(p: ChatProject, ev: MouseEvent) {
  if (projMenuFor.value === p.id) {
    projMenuFor.value = null;
    return;
  }
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  const width = 220;
  const x = Math.min(r.right - width + 8, window.innerWidth - width - 8);
  projMenuUp.value = r.bottom > window.innerHeight - 180;
  projMenuPos.value = { x: Math.max(8, x), y: projMenuUp.value ? r.top - 8 : r.bottom + 4 };
  projMenuFor.value = p.id;
}
function closeProjMenu() {
  projMenuFor.value = null;
}
async function startRenameProject(p: ChatProject) {
  closeProjMenu();
  renamingProjectId.value = p.id;
  projRenameDraft.value = p.name;
  await nextTick();
  const el = document.querySelector<HTMLInputElement>('.proj-rename');
  el?.focus();
  el?.select();
}
function cancelRenameProject() {
  renamingProjectId.value = null;
}
async function commitRenameProject(p: ChatProject) {
  if (renamingProjectId.value !== p.id) return; // guard: enter fires, then blur — only rename once
  renamingProjectId.value = null;
  const name = projRenameDraft.value.trim();
  if (!name || name === p.name) return;
  try {
    const res = await api.put<{ project: ChatProject }>(`/api/chat/projects/${p.id}`, { name });
    p.name = res.project.name;
    if (project.value?.project.id === p.id) project.value.project.name = res.project.name;
  } catch (e) {
    alert(e instanceof ApiError ? e.message : t('chat.couldNotUpdateProject'));
  }
}
async function openProjectSettings(p: ChatProject) {
  closeProjMenu();
  await openProject(p);
  showProjectSettings.value = true;
}
function deleteFromProjMenu(p: ChatProject) {
  closeProjMenu();
  deleteProject(p);
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
function openScheduleNew(projectId = '') {
  current.value = null;
  project.value = null;
  editingScheduleId.value = null;
  scheduleError.value = '';
  const p = providers.value[0];
  Object.assign(sf, {
    name: '', prompt: '', providerId: p?.id ?? '', model: p?.defaultModel ?? p?.models[0] ?? '',
    vserverSlug: '', projectId, kind: 'cron', cron: '0 9 * * 1', runAt: '',
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
  syncUrl();
}
function onScheduleProviderChange() {
  const p = providers.value.find((x) => x.id === sf.providerId);
  sf.model = p?.defaultModel ?? p?.models[0] ?? '';
}
async function saveSchedule() {
  scheduleError.value = '';
  if (!sf.name.trim() || !sf.prompt.trim() || !sf.providerId || !sf.model) {
    scheduleError.value = t('chat.scheduleFieldsRequired');
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
    scheduleError.value = e instanceof ApiError ? e.message : t('chat.couldNotSaveTask');
  } finally {
    savingSchedule.value = false;
  }
}
async function deleteSchedule(s: ChatSchedule) {
  if (!confirm(t('chat.confirmDeleteTask', { name: s.name }))) return;
  try {
    await api.del(`/api/chat/schedules/${s.id}`);
  } catch (e) {
    alert(e instanceof ApiError ? e.message : t('chat.couldNotDeleteTask'));
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
  if (!confirm(t('chat.confirmDeletePrompt', { name: p.name }))) return;
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

// Composer "+" menu (attach / prompts / memory / web search) — collapses the loose buttons into one entry.
const composerMenu = ref(false);

// Per-chat native web search (Claude/Gemini/OpenAI run the search server-side when this is on).
async function toggleWebSearch() {
  if (!current.value) return;
  const next = !current.value.webSearch;
  current.value.webSearch = next; // optimistic
  const c = conversations.value.find((x) => x.id === current.value!.id);
  if (c) c.webSearch = next;
  try {
    await api.put(`/api/chat/conversations/${current.value.id}`, { webSearch: next });
  } catch {
    current.value.webSearch = !next; // roll back
    if (c) c.webSearch = !next;
  }
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

// ── Org Agents (read-only presets defined by an admin; the user starts a chat from one) ──────────
// The client only sees a safe projection — the server never sends the sharing ACL or raw instructions.
type ClientAgent = Pick<ChatAgent, 'id' | 'name' | 'description' | 'providerId' | 'model'>;
const agents = ref<ClientAgent[]>([]);
const currentAgent = computed(() =>
  current.value?.agentId ? agents.value.find((a) => a.id === current.value!.agentId) : undefined,
);
/** Picking an agent pre-fills the chat's provider + model; its tools + instructions apply server-side. */
function onAgentChange() {
  const a = agents.value.find((x) => x.id === nc.agentId);
  if (!a) return;
  if (a.providerId && providers.value.some((p) => p.id === a.providerId)) {
    nc.providerId = a.providerId;
    nc.model = a.model || providers.value.find((p) => p.id === a.providerId)?.defaultModel || nc.model;
  }
}
/** Sidebar shortcut: open the new-chat modal already bound to this agent. */
function startFromAgent(a: ClientAgent) {
  openNew();
  nc.agentId = a.id;
  onAgentChange();
}

/** The models a provider offers, for a real <select>. `current` is kept in the list even when the provider no
 *  longer advertises it (a custom/legacy model a preset set), so selecting never silently blanks it. */
function modelsFor(providerId: string, current?: string): string[] {
  const list = providers.value.find((p) => p.id === providerId)?.models ?? [];
  return current && !list.includes(current) ? [current, ...list] : list;
}

function openNew(projectId = '') {
  newError.value = '';
  nc.agentId = '';
  nc.providerId = providers.value[0]?.id ?? '';
  nc.model = providers.value[0]?.defaultModel ?? providers.value[0]?.models[0] ?? '';
  nc.vserverSlug = '';
  nc.projectId = projectId;
  // A project can pin a default model — pre-fill it when starting a chat there.
  const dm = projectId ? projects.value.find((p) => p.id === projectId)?.defaultModel : '';
  if (dm) nc.model = dm;
  showNew.value = true;
}
function onProviderChange() {
  const p = providers.value.find((x) => x.id === nc.providerId);
  nc.model = p?.defaultModel ?? p?.models[0] ?? '';
}
async function createConversation() {
  newError.value = '';
  if (!nc.providerId || !nc.model) {
    newError.value = t('chat.pickProviderModel');
    return;
  }
  try {
    const res = await api.post<{ conversation: ChatConversation }>('/api/chat/conversations', {
      title: t('chat.newChat'),
      providerId: nc.providerId,
      model: nc.model,
      vserverSlug: nc.vserverSlug,
      ...(nc.agentId ? { agentId: nc.agentId } : {}),
      ...(nc.projectId ? { projectId: nc.projectId } : {}),
    });
    showNew.value = false;
    conversations.value.unshift(res.conversation);
    if (project.value && nc.projectId === project.value.project.id) project.value.conversations.unshift(res.conversation);
    project.value = null;
    current.value = res.conversation;
    messages.value = [];
    syncUrl();
  } catch (e) {
    newError.value = e instanceof ApiError ? e.message : t('chat.couldNotCreateChat');
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
          messages.value.push({ id: 'err-' + Date.now(), conversationId: conv.id, role: 'assistant', content: `⚠️ ${f.name}: ${err instanceof ApiError ? err.message : t('chat.uploadFailed')}`, createdAt: new Date().toISOString() });
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
  const text = input.value.trim() || (pending.value.length ? t('chat.reviewAttached') : '');
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
  liveSteps.value = [];
  scrollDown();
  // The stream ending is not a verdict — a dropped connection ends it too. Only a `done`/`failed` event is.
  let settled = false;
  try {
    await postSse(`/api/chat/conversations/${conv.id}/messages/stream`, { content: text, attachmentIds: attIds }, (event, data) => {
      if (current.value?.id !== conv.id) return; // user switched conversation mid-turn
      if (event === 'progress') {
        applyProgress(data);
      } else if (event === 'done') {
        settled = true;
        messages.value.push(data.message);
        for (const a of data.attachments ?? []) attachments.value.push(a); // interpreter-produced downloads
        scrollDown();
      } else if (event === 'failed') {
        settled = true;
        pushNotice(conv.id, `⚠️ ${data?.error?.message ?? t('chat.failedReply')}`);
      }
    });
    // Closed with no verdict: the connection dropped, but the turn keeps running server-side and persists its
    // reply on its own — so go look for it rather than declaring a failure that didn't happen.
    if (!settled && current.value?.id === conv.id) await reconcile(conv.id);
  } catch (e) {
    if (settled || current.value?.id !== conv.id) {
      /* already resolved, or the user moved on */
    } else if (e instanceof ApiError) {
      // The server refused before the stream began (unknown conversation, no provider, blocked by policy).
      // Nothing is running, so this IS the verdict.
      pushNotice(conv.id, `⚠️ ${e.message}`);
    } else {
      // The transport died mid-turn — the turn did not die with it. Reporting a failure here would be a lie
      // that costs the user a whole second turn; go look for the reply instead.
      await reconcile(conv.id);
    }
  } finally {
    sending.value = false;
    liveSteps.value = [];
    scrollDown();
  }
}

/** Fold one progress event into the live view. */
function applyProgress(p: { type: string; text?: string; name?: string; ok?: boolean }) {
  if (p.type === 'thinking' && p.text) {
    liveSteps.value.push({ kind: 'thinking', text: p.text });
  } else if (p.type === 'tool' && p.name) {
    liveSteps.value.push({ kind: 'tool', text: p.name });
  } else if (p.type === 'tool_result' && p.name) {
    // Settle the most recent still-running call of that tool (the same tool can be called more than once).
    for (let i = liveSteps.value.length - 1; i >= 0; i--) {
      const s = liveSteps.value[i];
      if (s.kind === 'tool' && s.text === p.name && s.ok === undefined) {
        s.ok = p.ok;
        break;
      }
    }
  }
  scrollDown();
}

function pushNotice(convId: string, content: string) {
  messages.value.push({ id: 'note-' + Date.now(), conversationId: convId, role: 'assistant', content, createdAt: new Date().toISOString() });
}

/** Re-read the thread after losing the live view, to pick up a reply the turn persisted without us. */
async function reconcile(convId: string) {
  try {
    const res = await api.get<{ messages: ChatMessage[]; attachments: ChatAttachment[] }>(`/api/chat/conversations/${convId}`);
    if (current.value?.id !== convId) return;
    messages.value = res.messages;
    attachments.value = res.attachments ?? [];
    // Last word still the user's ⇒ the turn is genuinely still running. Say so — don't imply it failed.
    if (res.messages[res.messages.length - 1]?.role !== 'assistant') pushNotice(convId, t('chat.streamDropped'));
  } catch {
    pushNotice(convId, t('chat.streamDropped'));
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
      <div class="brand-wrap">
        <div class="brand"><BrandLogo :size="24" /> {{ brandName }}</div>
        <PoweredByKravn v-if="brandCustomized" class="brand-pbk" />
      </div>
      <div style="padding: 10px">
        <button class="btn primary" style="width: 100%" @click="openNew()">{{ t('nav.newChat') }}</button>
        <input v-model="chatSearch" class="chat-search" :placeholder="t('nav.searchChats')" />
      </div>
      <div class="convs">
        <div class="side-section">
          <span>{{ t('nav.projects') }}</span>
          <button class="add" :title="t('nav.newProject')" @click="openNewProject">+</button>
        </div>
        <div v-if="projects.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">{{ t('nav.noProjects') }}</div>
        <div
          v-for="p in projects"
          :key="p.id"
          class="conv-item conv-row"
          :class="{ active: project?.project.id === p.id }"
          @click="renamingProjectId === p.id ? null : openProject(p)"
        >
          <input
            v-if="renamingProjectId === p.id"
            v-model="projRenameDraft"
            class="proj-rename"
            @click.stop
            @keydown.enter.prevent="commitRenameProject(p)"
            @keydown.esc.prevent="cancelRenameProject()"
            @blur="commitRenameProject(p)"
          />
          <template v-else>
            <span class="conv-item-title"><Folder :size="15" :stroke-width="2" /> {{ p.name }}
              <small v-if="p.access && p.access !== 'owner'" class="muted" style="display: block; font-size: 11px">{{ t('nav.shared') }} · {{ p.ownerEmail }}</small>
            </span>
            <button class="conv-menu-btn" :title="t('chatMenu.actions')" :aria-label="t('chatMenu.actions')" @click.stop="toggleProjMenu(p, $event)"><MoreHorizontal :size="16" :stroke-width="2" /></button>
            <div v-if="projMenuFor === p.id" class="conv-menu" :class="{ up: projMenuUp }" :style="{ left: projMenuPos.x + 'px', top: projMenuPos.y + 'px' }" @click.stop>
              <button v-if="p.access !== 'viewer'" class="conv-menu-item" @click="startRenameProject(p)"><span><Pencil :size="15" :stroke-width="2" /></span> {{ t('chatMenu.rename') }}</button>
              <button class="conv-menu-item" @click="openProjectSettings(p)"><span><Settings :size="15" :stroke-width="2" /></span> {{ t('chat.projectSettings') }}</button>
              <button v-if="p.access === 'owner'" class="conv-menu-item danger" @click="deleteFromProjMenu(p)"><span><Trash2 :size="15" :stroke-width="2" /></span> {{ t('chatMenu.delete') }}</button>
            </div>
          </template>
        </div>

        <template v-if="agents.length">
          <div class="side-section" style="margin-top: 6px"><span>{{ t('nav.agents') }}</span></div>
          <div v-for="a in agents" :key="a.id" class="conv-item" :title="a.description || a.name" @click="startFromAgent(a)">
            <Bot :size="15" :stroke-width="2" /> {{ a.name }}
            <small class="muted" style="display: block; font-size: 11px">{{ t('nav.agentOrg') }}</small>
          </div>
        </template>

        <div class="side-section" style="margin-top: 6px"><span>{{ t('nav.chats') }}</span></div>
        <div v-if="allTags.length" class="tag-bar">
          <button
            v-for="tag in allTags"
            :key="tag"
            class="tag-chip"
            :class="{ active: activeTag?.toLowerCase() === tag.toLowerCase() }"
            @click="toggleTagFilter(tag)"
          >{{ tag }}</button>
        </div>
        <div v-if="conversations.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">{{ t('nav.noChatsYet') }}</div>
        <div v-else-if="filteredConversations.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">{{ t('nav.noChatsMatch') }}</div>
        <div
          v-for="c in filteredConversations"
          :key="c.id"
          class="conv-item conv-row"
          :class="{ active: current?.id === c.id }"
          @click="open(c)"
        >
          <span class="conv-item-title"><span v-if="c.pinned" class="pin-dot" :title="t('chat.pinned')"><Pin :size="14" :stroke-width="2" /></span>{{ c.title || t('chat.newChat') }}</span>
          <button class="conv-menu-btn" :title="t('chatMenu.actions')" :aria-label="t('chatMenu.actions')" @click.stop="toggleMenu(c, $event)"><MoreHorizontal :size="16" :stroke-width="2" /></button>
          <div v-if="menuFor === c.id" class="conv-menu" :class="{ up: menuUp }" :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }" @click.stop>
            <button class="conv-menu-item" @click="renameFromMenu(c)"><span><Pencil :size="15" :stroke-width="2" /></span> {{ t('chatMenu.rename') }}</button>
            <div class="conv-menu-item has-sub" @click.stop="moveSubmenu = !moveSubmenu">
              <span><Folder :size="15" :stroke-width="2" /></span> {{ t('chatMenu.moveToProject') }} <span class="sub-caret"><ChevronRight :size="14" :stroke-width="2" /></span>
              <div v-if="moveSubmenu" class="conv-submenu">
                <button class="conv-menu-item" @click="moveToProject(c, '')"><span><Ban :size="15" :stroke-width="2" /></span> {{ t('chatMenu.noProject') }}</button>
                <button v-for="p in projects" :key="p.id" class="conv-menu-item" @click="moveToProject(c, p.id)">
                  <span><Folder :size="15" :stroke-width="2" /></span> {{ p.name }}
                </button>
              </div>
            </div>
            <button class="conv-menu-item" @click="togglePin(c)"><span><Pin :size="15" :stroke-width="2" /></span> {{ c.pinned ? t('chatMenu.unpin') : t('chatMenu.pin') }}</button>
            <button class="conv-menu-item" @click="toggleArchive(c)"><span><Archive :size="15" :stroke-width="2" /></span> {{ t('chatMenu.archive') }}</button>
            <button class="conv-menu-item danger" @click="deleteFromMenu(c)"><span><Trash2 :size="15" :stroke-width="2" /></span> {{ t('chatMenu.delete') }}</button>
          </div>
        </div>

        <div class="side-section" style="margin-top: 6px">
          <span>{{ t('nav.scheduled') }}</span>
          <button class="add" :title="t('nav.newScheduledTask')" @click="openScheduleNew()">+</button>
        </div>
        <div v-if="schedules.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">{{ t('nav.noScheduledTasks') }}</div>
        <div
          v-for="s in schedules"
          :key="s.id"
          class="conv-item conv-row"
          :class="{ active: scheduleView && editingScheduleId === s.id }"
          @click="openSchedule(s)"
        >
          <span class="conv-item-title"><Clock :size="15" :stroke-width="2" /> {{ s.name }}<span v-if="!s.enabled" class="muted"> · {{ t('nav.paused') }}</span></span>
          <button class="conv-del" :title="t('chatMenu.deleteTask')" :aria-label="t('chatMenu.deleteTask')" @click.stop="deleteSchedule(s)"><Trash2 :size="16" :stroke-width="2" /></button>
        </div>

        <div class="side-section archived-toggle" style="margin-top: 6px" @click="toggleArchivedView">
          <span><Archive :size="15" :stroke-width="2" /> {{ t('nav.archived') }}<span v-if="archived.length"> ({{ archived.length }})</span></span>
          <span class="caret"><component :is="showArchived ? ChevronDown : ChevronRight" :size="14" :stroke-width="2" /></span>
        </div>
        <template v-if="showArchived">
          <div v-if="archived.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">{{ t('nav.noArchived') }}</div>
          <div
            v-for="c in archived"
            :key="c.id"
            class="conv-item conv-row"
            :class="{ active: current?.id === c.id }"
            @click="open(c)"
          >
            <span class="conv-item-title">{{ c.title || t('chat.newChat') }}</span>
            <button class="conv-menu-btn" :title="t('chatMenu.actions')" :aria-label="t('chatMenu.actions')" @click.stop="toggleMenu(c, $event)"><MoreHorizontal :size="16" :stroke-width="2" /></button>
            <div v-if="menuFor === c.id" class="conv-menu" :class="{ up: menuUp }" :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }" @click.stop>
              <button class="conv-menu-item" @click="toggleArchive(c)"><span><ArchiveRestore :size="15" :stroke-width="2" /></span> {{ t('chatMenu.unarchive') }}</button>
              <button class="conv-menu-item danger" @click="deleteFromMenu(c)"><span><Trash2 :size="15" :stroke-width="2" /></span> {{ t('chatMenu.delete') }}</button>
            </div>
          </div>
        </template>
      </div>
      <div v-if="menuFor" class="menu-backdrop" @click="closeMenu"></div>
      <div v-if="projMenuFor" class="menu-backdrop" @click="closeProjMenu"></div>
      <div class="foot">
        <button class="foot-user" :title="t('settings.title')" @click="showSettings = true">
          <span class="foot-email muted">{{ auth.user?.email }}</span>
          <span class="foot-gear"><Settings :size="16" /></span>
        </button>
        <button class="btn" @click="logout">{{ t('nav.signOut') }}</button>
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
          <span v-else class="chat-title" :title="t('chat.clickToRename')" @click="startRenameTitle">{{ current.title || t('chat.newChat') }}</span>
          <span class="chat-head-right">
            <small v-if="currentAgent" class="muted"><Bot :size="14" :stroke-width="2" /> {{ currentAgent.name }} · </small>
            <small class="muted">{{ current.model }}<span v-if="current.vserverSlug"> · {{ t('chat.toolsInline', { slug: current.vserverSlug }) }}</span></small>
            <button class="conv-del head-del" :title="t('chat.deleteChat')" :aria-label="t('chat.deleteChat')" @click="deleteConversation(current)"><Trash2 :size="16" :stroke-width="2" /></button>
          </span>
        </div>
        <div class="chat-tags">
          <span v-for="tag in (current.tags ?? [])" :key="tag" class="tag-chip static">
            {{ tag }}<button class="tag-x" :title="t('chat.removeTag')" :aria-label="t('chat.removeTag')" @click="removeTag(tag)"><X :size="14" :stroke-width="2" /></button>
          </span>
          <input
            v-model="tagDraft"
            class="tag-input"
            maxlength="40"
            :placeholder="t('chat.tagPlaceholder')"
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
                  :title="t('chat.downloadFile', { name: a.name })"
                  @click="downloadAttachment(a)"
                >
                  <Paperclip :size="14" :stroke-width="2" /> {{ a.name }} <small class="muted">{{ fmtSize(a.size) }}</small> <span class="dl-icon"><Download :size="14" :stroke-width="2" /></span>
                </button>
              </div>
            </div>
          </div>
          <!-- The turn, live: the assistant's reasoning between rounds and each tool as it runs, streamed in
               while it works. Replaced by the real reply when it lands. -->
          <div v-if="sending" class="msg assistant">
            <div class="bubble thinking">
              <div v-for="(s, i) in liveSteps" :key="i" class="live-step">
                <p v-if="s.kind === 'thinking'" class="live-think">{{ s.text }}</p>
                <span v-else class="live-tool" :class="s.ok === undefined ? 'run' : s.ok ? 'ok' : 'err'">
                  <i class="live-dot" aria-hidden="true"></i>{{ t('chat.usingTool', { tool: s.text }) }}
                </span>
              </div>
              <div class="live-now">
                <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <span class="muted">{{ t('chat.thinking') }}</span>
              </div>
            </div>
          </div>
        </div>
        <div
          class="composer-wrap"
          :class="{ dragging: dragOver }"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <div v-if="dragOver" class="drop-hint">{{ t('chat.dropFiles') }}</div>
          <div v-if="pending.length || uploading || current?.webSearch" class="att-tray">
            <span v-if="current?.webSearch" class="mode-chip">
              <Globe :size="13" :stroke-width="2" /> {{ t('chat.webSearch') }}
              <button class="mode-chip-x" :title="t('chat.webSearchOn')" :aria-label="t('chat.webSearchOn')" @click="toggleWebSearch()"><X :size="13" :stroke-width="2" /></button>
            </span>
            <span v-for="a in pending" :key="a.id" class="att-chip">
              <Paperclip :size="14" :stroke-width="2" /> {{ a.name }} <small class="muted">{{ fmtSize(a.size) }}{{ a.textChars ? '' : t('chat.noTextSuffix') }}</small>
              <button class="att-x" :title="t('chat.remove')" :aria-label="t('chat.remove')" @click="removePending(a)"><X :size="14" :stroke-width="2" /></button>
            </span>
            <span v-if="uploading" class="muted" style="font-size: 12px">{{ t('chat.uploading') }}</span>
          </div>
          <div class="composer">
            <input ref="fileInput" type="file" multiple style="display: none"
              accept=".pdf,.doc,.docx,.txt,.md,.csv,.tsv,.xlsx,.xls,.json,.log,.yaml,.yml,.xml,.html,.png,.jpg,.jpeg,.webp,.gif"
              @change="onFilesSelected" />
            <div class="composer-plus" @keydown.esc="composerMenu = false">
              <button
                class="btn icon"
                :class="{ on: current?.webSearch }"
                :title="t('chat.composerAdd')"
                :aria-label="t('chat.composerAdd')"
                :aria-expanded="composerMenu"
                @click.stop="composerMenu = !composerMenu"
              ><Plus :size="18" :stroke-width="2" /></button>
              <div v-if="composerMenu" class="composer-menu" @click.stop>
                <button class="conv-menu-item" :disabled="uploading" @click="composerMenu = false; triggerPick()">
                  <Paperclip :size="16" :stroke-width="2" /> {{ t('chat.attachFiles') }}
                </button>
                <button class="conv-menu-item" @click="composerMenu = false; openPrompts()">
                  <ClipboardList :size="16" :stroke-width="2" /> {{ t('chat.promptLibrary') }}
                </button>
                <button class="conv-menu-item" @click="composerMenu = false; openMemory()">
                  <Brain :size="16" :stroke-width="2" /> {{ t('chat.memoryTooltip') }}
                </button>
                <button class="conv-menu-item" :aria-pressed="!!current?.webSearch" @click="toggleWebSearch()">
                  <Globe :size="16" :stroke-width="2" /> {{ t('chat.webSearch') }}
                  <Check v-if="current?.webSearch" :size="16" :stroke-width="2" class="composer-check" />
                </button>
              </div>
            </div>
            <textarea v-model="input" rows="2" :placeholder="t('chat.messagePlaceholder')" @keydown.enter.exact.prevent="send"></textarea>
            <button class="btn primary" :disabled="sending || uploading || (!input.trim() && pending.length === 0)" @click="send">{{ t('chat.send') }}</button>
          </div>
          <div v-if="composerMenu" class="menu-backdrop" @click="composerMenu = false"></div>
        </div>
      </template>

      <!-- Project panel -->
      <div v-else-if="project" class="project-panel">
        <div class="chat-head" style="padding: 0 0 0.75rem; border-bottom: 1px solid var(--border)">
          <span><Folder :size="16" :stroke-width="2" /> {{ project.project.name }}
            <small v-if="project.project.access !== 'owner'" class="muted" style="font-size: 12px">· {{ project.project.access }} · {{ t('chat.sharedBy', { email: project.project.ownerEmail }) }}</small>
          </span>
          <div class="btn-row">
            <button class="btn primary" @click="openNew(project.project.id)">{{ t('chat.newChatInProject') }}</button>
            <button class="btn" @click="openScheduleNew(project.project.id)">{{ t('chat.newScheduledTaskInProject') }}</button>
            <button class="btn icon" :class="{ active: showProjectSettings }" :title="t('chat.projectSettings')" :aria-label="t('chat.projectSettings')" @click="showProjectSettings = !showProjectSettings"><Settings :size="16" :stroke-width="2" /></button>
            <button v-if="isOwner" class="btn" @click="deleteProject(project.project)">{{ t('chat.delete') }}</button>
          </div>
        </div>

        <!-- CHATS-FIRST: the project's chats + scheduled tasks are the default view -->
        <template v-if="!showProjectSettings">
          <div class="panel-card">
            <h3>{{ t('chat.chatsInProject') }} <span class="muted" style="font-weight: 400">({{ project.conversations.length }})</span></h3>
            <div v-if="project.conversations.length === 0" class="muted" style="font-size: 13px">{{ t('chat.noChatsInProject') }}</div>
            <div v-for="c in project.conversations" :key="c.id" class="conv-item" @click="open(c)"><MessageSquare :size="15" :stroke-width="2" /> {{ c.title || t('chat.newChat') }}</div>
          </div>

          <div class="panel-card" v-if="projectSchedules.length">
            <h3>{{ t('chat.scheduledTasks') }} <span class="muted" style="font-weight: 400">({{ projectSchedules.length }})</span></h3>
            <div v-for="s in projectSchedules" :key="s.id" class="conv-item" @click="openSchedule(s)"><Clock :size="15" :stroke-width="2" /> {{ s.name }}<span v-if="!s.enabled" class="muted"> · {{ t('nav.paused') }}</span></div>
          </div>
        </template>

        <!-- SETTINGS (gear): instructions, documents, sharing -->
        <template v-else>
          <div class="panel-card">
            <h3>{{ t('chat.projectInstructions') }}</h3>
            <p class="muted" style="margin: 0; font-size: 12px">{{ t('chat.projectInstructionsHint') }}</p>
            <textarea v-model="project.project.instructions" rows="5" :readonly="!canEdit" :placeholder="t('chat.instructionsPlaceholder')"></textarea>
            <div v-if="canEdit" class="btn-row" style="justify-content: flex-end">
              <button class="btn primary" :disabled="savingInstr" @click="saveInstructions">{{ savingInstr ? t('chat.saving') : t('chat.saveInstructions') }}</button>
            </div>
          </div>

          <div class="panel-card">
            <h3>{{ t('chat.projectDefaultModel') }}</h3>
            <p class="muted" style="margin: 0; font-size: 12px">{{ t('chat.projectDefaultModelHint') }}</p>
            <select v-model="project.project.defaultModel" :disabled="!canEdit">
              <option value="">{{ t('chat.projectDefaultModelNone') }}</option>
              <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
            </select>
            <div v-if="canEdit" class="btn-row" style="justify-content: flex-end">
              <button class="btn primary" :disabled="savingModel" @click="saveDefaultModel">{{ savingModel ? t('chat.saving') : t('chat.save') }}</button>
            </div>
          </div>

          <div class="panel-card">
            <h3>{{ t('chat.projectTools') }} <span class="muted" style="font-weight: 400">({{ selectedToolIds.length }})</span></h3>
            <p class="muted" style="margin: 0; font-size: 12px">{{ t('chat.projectToolsHint') }}</p>
            <GroupedSelect
              v-model="selectedToolIds"
              :items="toolItems"
              :groups="toolServerMeta"
              :noun="t('grouped.nounTools')"
              :disabled="!canEdit"
              :empty-text="t('chat.noToolsAvailable')"
            />
            <div v-if="canEdit && toolItems.length" class="btn-row" style="justify-content: flex-end">
              <button class="btn primary" :disabled="savingTools" @click="saveProjectTools">{{ savingTools ? t('chat.saving') : t('chat.saveTools') }}</button>
            </div>
          </div>

          <div class="panel-card">
            <h3>{{ t('chat.documents') }} <span class="muted" style="font-weight: 400">({{ project.documents.length }})</span></h3>
            <p class="muted" style="margin: 0; font-size: 12px">{{ t('chat.documentsHint') }}</p>
            <div v-if="project.documents.length === 0" class="muted" style="font-size: 13px">{{ t('chat.noDocuments') }}</div>
            <div v-for="d in project.documents" :key="d.id" class="doc-item">
              <span><FileText :size="15" :stroke-width="2" /> {{ d.name }}</span>
              <span class="row" style="gap: 0.6rem; align-items: center">
                <span class="doc-meta">{{ Math.ceil(d.size / 1024) }} KB</span>
                <button v-if="canEdit" class="btn" @click="deleteDocument(d)">{{ t('chat.remove') }}</button>
              </span>
            </div>
            <template v-if="canEdit">
              <hr style="border: none; border-top: 1px solid var(--border); margin: 0.4rem 0" />
              <div class="field"><label>{{ t('chat.addDocument') }}</label><input v-model="newDoc.name" :placeholder="t('chat.docNamePlaceholder')" /></div>
              <textarea v-model="newDoc.content" rows="4" :placeholder="t('chat.docContentPlaceholder')"></textarea>
              <div class="btn-row" style="justify-content: flex-end">
                <button class="btn primary" :disabled="docBusy || !newDoc.name.trim() || !newDoc.content.trim()" @click="addDocument">{{ docBusy ? t('chat.adding') : t('chat.addDocument') }}</button>
              </div>
            </template>
          </div>

          <!-- Sharing (owner only) -->
          <div v-if="isOwner" class="panel-card">
            <h3>{{ t('chat.sharing') }} <span class="muted" style="font-weight: 400">({{ project.members.length }})</span></h3>
            <p class="muted" style="margin: 0; font-size: 12px">{{ t('chat.sharingHint') }}</p>
            <div v-if="project.members.length === 0" class="muted" style="font-size: 13px">{{ t('chat.notSharedYet') }}</div>
            <div v-for="m in project.members" :key="m.userId" class="doc-item">
              <span><User :size="15" :stroke-width="2" /> {{ m.email }}</span>
              <span class="row" style="gap: 0.6rem; align-items: center">
                <span class="doc-meta">{{ m.role }}</span>
                <button class="btn" @click="unshareMember(m)">{{ t('chat.remove') }}</button>
              </span>
            </div>
            <hr style="border: none; border-top: 1px solid var(--border); margin: 0.4rem 0" />
            <div class="row" style="gap: 0.5rem; align-items: flex-end; flex-wrap: wrap">
              <div class="field" style="flex: 1; min-width: 180px">
                <label>{{ t('chat.shareWithUser') }}</label>
                <select v-model="share.email">
                  <option value="">{{ shareCandidates.length ? t('chat.selectUser') : t('chat.noUsersToShare') }}</option>
                  <option v-for="u in shareCandidates" :key="u.id" :value="u.email">{{ u.name ? `${u.name} · ${u.email}` : u.email }}</option>
                </select>
              </div>
              <div class="field"><label>{{ t('chat.role') }}</label>
                <select v-model="share.role"><option value="viewer">{{ t('chat.viewer') }}</option><option value="editor">{{ t('chat.editor') }}</option></select>
              </div>
              <button class="btn primary" :disabled="sharing || !share.email" @click="shareProject">{{ sharing ? t('chat.sharingBtn') : t('chat.share') }}</button>
            </div>
            <p v-if="shareError" class="muted" style="color: #e5484d; font-size: 12px; margin: 0.3rem 0 0">{{ shareError }}</p>
          </div>
        </template>
      </div>

      <!-- Empty -->
      <!-- Scheduled task editor -->
      <div v-else-if="scheduleView" class="project-panel">
        <div class="chat-head" style="padding: 0 0 0.75rem; border-bottom: 1px solid var(--border)">
          <span><Clock :size="16" :stroke-width="2" /> {{ editingScheduleId ? t('chat.editScheduledTask') : t('chat.newScheduledTask') }}</span>
        </div>

        <div class="panel-card">
          <div class="field"><label>{{ t('chat.name') }}</label><input v-model="sf.name" :placeholder="t('chat.taskNamePlaceholder')" /></div>
          <div class="field"><label>{{ t('chat.promptWhatToRun') }}</label><textarea v-model="sf.prompt" rows="4" :placeholder="t('chat.taskPromptPlaceholder')"></textarea></div>
          <div class="row" style="gap: 0.5rem; flex-wrap: wrap">
            <div class="field" style="flex: 1; min-width: 150px"><label>{{ t('chat.provider') }}</label>
              <select v-model="sf.providerId" @change="onScheduleProviderChange">
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <div class="field" style="flex: 1; min-width: 150px"><label>{{ t('chat.model') }}</label>
              <select v-if="modelsFor(sf.providerId, sf.model).length" v-model="sf.model">
                <option v-for="m in modelsFor(sf.providerId, sf.model)" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else v-model="sf.model" :placeholder="t('chat.modelPlaceholder')" />
            </div>
          </div>
          <div class="row" style="gap: 0.5rem; flex-wrap: wrap">
            <div class="field" style="flex: 1; min-width: 150px"><label>{{ t('chat.toolsMcpEndpoint') }}</label>
              <select v-model="sf.vserverSlug">
                <option value="">{{ t('chat.none') }}</option>
                <option v-for="v in vservers" :key="v.slug" :value="v.slug">{{ v.name }}</option>
              </select>
            </div>
            <div class="field" style="flex: 1; min-width: 150px"><label>{{ t('chat.projectContext') }}</label>
              <select v-model="sf.projectId">
                <option value="">{{ t('chat.none') }}</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="panel-card">
          <h3>{{ t('chat.when') }}</h3>
          <div class="row" style="gap: 1rem">
            <label class="row" style="gap: 0.3rem; align-items: center"><input type="radio" value="cron" v-model="sf.kind" /> {{ t('chat.recurringCron') }}</label>
            <label class="row" style="gap: 0.3rem; align-items: center"><input type="radio" value="once" v-model="sf.kind" /> {{ t('chat.once') }}</label>
          </div>
          <div v-if="sf.kind === 'cron'" class="field"><label>{{ t('chat.cronExpression') }}</label>
            <input v-model="sf.cron" placeholder="0 9 * * 1" />
            <small class="muted">{{ t('chat.cronHelp1') }} <code>*/30 * * * *</code> {{ t('chat.cronHelp2') }} <code>0 9 * * 1</code> {{ t('chat.cronHelp3') }}</small>
          </div>
          <div v-else class="field"><label>{{ t('chat.runAt') }}</label><input v-model="sf.runAt" type="datetime-local" /></div>
          <div class="field"><label>{{ t('chat.timezone') }}</label><input v-model="sf.timezone" placeholder="UTC" /></div>
          <label class="row" style="gap: 0.4rem; align-items: center; margin-top: 0.3rem"><input type="checkbox" v-model="sf.enabled" /> {{ t('chat.enabled') }}</label>
        </div>

        <p v-if="scheduleError" class="muted" style="color: #e5484d; font-size: 12px">{{ scheduleError }}</p>
        <div class="btn-row" style="justify-content: space-between">
          <button v-if="scheduleById(editingScheduleId)" class="btn" @click="deleteSchedule(scheduleById(editingScheduleId)!)">{{ t('chat.delete') }}</button>
          <span></span>
          <button class="btn primary" :disabled="savingSchedule" @click="saveSchedule">{{ savingSchedule ? t('chat.saving') : t('chat.saveTask') }}</button>
        </div>

        <div v-if="scheduleById(editingScheduleId)" class="panel-card">
          <h3>{{ t('chat.status') }}</h3>
          <div class="muted" style="font-size: 13px; display: flex; flex-direction: column; gap: 2px">
            <span>{{ t('chat.nextRun') }} {{ scheduleById(editingScheduleId)?.nextRunAt || (scheduleById(editingScheduleId)?.enabled ? '—' : t('chat.paused')) }}</span>
            <span v-if="scheduleById(editingScheduleId)?.lastRunAt">{{ t('chat.lastRun') }} {{ scheduleById(editingScheduleId)?.lastRunAt }} · {{ scheduleById(editingScheduleId)?.lastStatus }}</span>
            <span v-if="scheduleById(editingScheduleId)?.lastError" style="color: #e5484d">{{ scheduleById(editingScheduleId)?.lastError }}</span>
          </div>
        </div>
      </div>

      <div v-else class="chat-empty">
        <BrandLogo :size="48" />
        <PoweredByKravn v-if="brandCustomized" style="margin-top: -4px" />
        <p>{{ t('chat.emptyPrompt') }}</p>
        <div class="btn-row">
          <button class="btn primary" @click="openNew()">{{ t('chat.newChatBtn') }}</button>
          <button class="btn" @click="openNewProject">{{ t('chat.newProjectBtn') }}</button>
        </div>
      </div>
    </main>

    <!-- New chat modal -->
    <div v-if="showNew" class="modal-backdrop" @click.self="showNew = false">
      <div class="modal">
        <h2>{{ t('chat.newChat') }}</h2>
        <div v-if="newError" class="alert error">{{ newError }}</div>
        <div v-if="providers.length === 0" class="alert error">
          {{ t('chat.noProvidersConfigured') }}
        </div>
        <div v-if="agents.length" class="field">
          <label>{{ t('chat.agentOptional') }}</label>
          <select v-model="nc.agentId" @change="onAgentChange">
            <option value="">{{ t('chat.noAgent') }}</option>
            <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
          <small class="muted">{{ t('chat.agentHint') }}</small>
        </div>
        <div class="field">
          <label>{{ t('chat.modelProvider') }}</label>
          <select v-model="nc.providerId" @change="onProviderChange">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>{{ t('chat.model') }}</label>
          <select v-if="modelsFor(nc.providerId, nc.model).length" v-model="nc.model">
            <option v-for="m in modelsFor(nc.providerId, nc.model)" :key="m" :value="m">{{ m }}</option>
          </select>
          <input v-else v-model="nc.model" :placeholder="t('chat.modelPlaceholder')" />
        </div>
        <div v-if="!newChatUsesProjectTools" class="field">
          <label>{{ t('chat.toolsOptional') }}</label>
          <select v-model="nc.vserverSlug">
            <option value="">{{ t('chat.noTools') }}</option>
            <option v-for="v in vservers" :key="v.slug" :value="v.slug">{{ v.name }}</option>
          </select>
        </div>
        <div v-else class="field">
          <small class="muted"><Wrench :size="14" :stroke-width="2" /> {{ t('chat.usesProjectTools') }}</small>
        </div>
        <div class="field">
          <label>{{ t('chat.projectOptional') }}</label>
          <select v-model="nc.projectId">
            <option value="">{{ t('chat.noProject') }}</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <small class="muted">{{ t('chat.projectHint') }}</small>
        </div>
        <div class="btn-row" style="justify-content: flex-end">
          <button class="btn" @click="showNew = false">{{ t('chat.cancel') }}</button>
          <button class="btn primary" :disabled="providers.length === 0" @click="createConversation">{{ t('chat.create') }}</button>
        </div>
      </div>
    </div>

    <!-- New project modal -->
    <div v-if="showNewProject" class="modal-backdrop" @click.self="showNewProject = false">
      <div class="modal">
        <h2>{{ t('chat.newProject') }}</h2>
        <div v-if="projectError" class="alert error">{{ projectError }}</div>
        <div class="field"><label>{{ t('chat.name') }}</label><input v-model="np.name" :placeholder="t('chat.newProjectNamePlaceholder')" autofocus /></div>
        <div class="field">
          <label>{{ t('chat.instructionsOptional') }}</label>
          <textarea v-model="np.instructions" rows="4" :placeholder="t('chat.projectInstructionsPlaceholder')"></textarea>
        </div>
        <div class="btn-row" style="justify-content: flex-end">
          <button class="btn" @click="showNewProject = false">{{ t('chat.cancel') }}</button>
          <button class="btn primary" @click="createProject">{{ t('chat.create') }}</button>
        </div>
      </div>
    </div>

    <!-- Prompt library -->
    <div v-if="showPrompts" class="modal-backdrop" @click.self="showPrompts = false">
      <div class="modal">
        <div class="btn-row" style="justify-content: space-between; align-items: center">
          <h2 style="margin: 0">{{ promptEditing ? (editingPromptId ? t('chat.editPrompt') : t('chat.newPrompt')) : t('chat.promptLibrary') }}</h2>
          <button v-if="!promptEditing" class="btn primary" @click="newPrompt">{{ t('chat.addNew') }}</button>
        </div>
        <template v-if="!promptEditing">
          <p class="muted" style="font-size: 12px; margin: 0.2rem 0">{{ t('chat.promptsHint') }}</p>
          <div v-if="prompts.length === 0" class="muted" style="font-size: 13px; padding: 0.5rem 0">{{ t('chat.noPromptsYet') }}</div>
          <div v-for="p in prompts" :key="p.id" class="doc-item">
            <span class="conv-item-title"><ClipboardList :size="15" :stroke-width="2" /> {{ p.name }}</span>
            <span class="row" style="gap: 0.4rem; align-items: center">
              <button class="btn" @click="usePrompt(p)">{{ t('chat.use') }}</button>
              <button class="btn" @click="editPrompt(p)">{{ t('chat.edit') }}</button>
              <button class="btn icon" :title="t('chat.delete')" :aria-label="t('chat.delete')" @click="deletePrompt(p)"><Trash2 :size="16" :stroke-width="2" /></button>
            </span>
          </div>
          <div class="btn-row" style="justify-content: flex-end; margin-top: 0.5rem">
            <button class="btn" @click="showPrompts = false">{{ t('chat.close') }}</button>
          </div>
        </template>
        <template v-else>
          <div class="field"><label>{{ t('chat.name') }}</label><input v-model="pform.name" :placeholder="t('chat.promptNamePlaceholder')" autofocus /></div>
          <div class="field"><label>{{ t('chat.prompt') }}</label><textarea v-model="pform.content" rows="6" :placeholder="t('chat.promptTextPlaceholder')"></textarea></div>
          <div class="btn-row" style="justify-content: flex-end">
            <button class="btn" @click="promptEditing = false">{{ t('chat.back') }}</button>
            <button class="btn primary" :disabled="!pform.name.trim() || !pform.content.trim()" @click="savePrompt">{{ t('chat.save') }}</button>
          </div>
        </template>
      </div>
    </div>

    <!-- Persistent memory -->
    <div v-if="showMemory" class="modal-backdrop" @click.self="showMemory = false">
      <div class="modal">
        <h2 style="margin: 0 0 0.2rem">{{ t('chat.memory') }}</h2>
        <p class="muted" style="font-size: 12px; margin: 0.2rem 0">
          {{ t('chat.memoryHint') }}
        </p>
        <div v-if="memory.length === 0" class="muted" style="font-size: 13px; padding: 0.5rem 0">{{ t('chat.noMemories') }}</div>
        <div v-for="m in memory" :key="m.id" class="doc-item">
          <span class="conv-item-title" style="white-space: normal"><Brain :size="15" :stroke-width="2" /> {{ m.content }}</span>
          <button class="btn icon" :title="t('chat.forget')" :aria-label="t('chat.forget')" @click="deleteMemory(m)"><Trash2 :size="16" :stroke-width="2" /></button>
        </div>
        <div class="field" style="margin-top: 0.5rem">
          <label>{{ t('chat.addMemory') }}</label>
          <textarea v-model="memoryDraft" rows="2" maxlength="2000" :placeholder="t('chat.memoryPlaceholder')" @keydown.enter.exact.prevent="addMemory"></textarea>
        </div>
        <div class="btn-row" style="justify-content: flex-end">
          <button class="btn" @click="showMemory = false">{{ t('chat.close') }}</button>
          <button class="btn primary" :disabled="!memoryDraft.trim() || savingMemory" @click="addMemory">{{ t('chat.add') }}</button>
        </div>
      </div>
    </div>

    <!-- Settings (user profile) -->
    <div v-if="showSettings" class="modal-backdrop" @click.self="showSettings = false">
      <div class="modal">
        <h2>{{ t('settings.title') }}</h2>
        <div class="field">
          <label>{{ t('settings.signedInAs') }}</label>
          <div class="muted">{{ auth.user?.email }}</div>
        </div>
        <div class="field">
          <label>{{ t('common.language') }}</label>
          <LocaleSwitcher />
        </div>
        <div class="btn-row" style="justify-content: flex-end">
          <button class="btn" @click="showSettings = false">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
