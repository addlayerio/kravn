<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ChatConversation, ChatMessage, ChatProject, ChatProjectDocument, ChatAttachment } from '@kravn/contracts';
import { api, ApiError } from '../api';
import { useAuthStore } from '../stores/auth';
import RavenLogo from '../RavenLogo.vue';

interface ProviderOpt { id: string; name: string; models: string[]; defaultModel: string }
interface VsOpt { slug: string; name: string }
interface ProjectDetail { project: ChatProject; documents: ChatProjectDocument[]; conversations: ChatConversation[] }

const auth = useAuthStore();
const router = useRouter();

const providers = ref<ProviderOpt[]>([]);
const vservers = ref<VsOpt[]>([]);
const conversations = ref<ChatConversation[]>([]);
const projects = ref<ChatProject[]>([]);

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
const nc = reactive({ providerId: '', model: '', vserverSlug: '', projectId: '' });
const newError = ref('');

// New-project modal
const showNewProject = ref(false);
const np = reactive({ name: '', instructions: '' });
const projectError = ref('');

// Project panel edit state
const savingInstr = ref(false);
const newDoc = reactive({ name: '', content: '' });
const docBusy = ref(false);

async function load() {
  const [opts, convs, projs] = await Promise.all([
    api.get<{ providers: ProviderOpt[]; mcpEndpoints: VsOpt[] }>('/api/chat/options'),
    api.get<{ conversations: ChatConversation[] }>('/api/chat/conversations'),
    api.get<{ projects: ChatProject[] }>('/api/chat/projects'),
  ]);
  providers.value = opts.providers;
  vservers.value = opts.mcpEndpoints;
  conversations.value = convs.conversations;
  projects.value = projs.projects;
}
onMounted(load);

async function scrollDown() {
  await nextTick();
  if (thread.value) thread.value.scrollTop = thread.value.scrollHeight;
}

async function open(c: ChatConversation) {
  project.value = null;
  pending.value = [];
  const res = await api.get<{ conversation: ChatConversation; messages: ChatMessage[]; attachments: ChatAttachment[] }>(`/api/chat/conversations/${c.id}`);
  current.value = res.conversation;
  messages.value = res.messages;
  attachments.value = res.attachments ?? [];
  scrollDown();
}

// ── Projects ──────────────────────────────────────────────────────────────
async function openProject(p: ChatProject) {
  current.value = null;
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
async function deleteProject(p: ChatProject) {
  if (!confirm(`Delete project “${p.name}”? Its documents are removed; its chats are kept.`)) return;
  await api.del(`/api/chat/projects/${p.id}`);
  projects.value = projects.value.filter((x) => x.id !== p.id);
  if (project.value?.project.id === p.id) project.value = null;
}

// ── New chat ──────────────────────────────────────────────────────────────
function openNew(projectId = '') {
  newError.value = '';
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
async function onFilesSelected(e: Event) {
  const el = e.target as HTMLInputElement;
  const files = Array.from(el.files ?? []);
  el.value = ''; // allow re-selecting the same file
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
        </div>

        <div class="side-section" style="margin-top: 6px"><span>Chats</span></div>
        <div v-if="conversations.length === 0" class="muted" style="padding: 0.25rem 0.7rem; font-size: 13px">No chats yet.</div>
        <div
          v-for="c in conversations"
          :key="c.id"
          class="conv-item"
          :class="{ active: current?.id === c.id }"
          @click="open(c)"
        >
          {{ c.title || 'New chat' }}
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
          <span>{{ current.title }}</span>
          <small class="muted">{{ current.model }}<span v-if="current.vserverSlug"> · tools: {{ current.vserverSlug }}</span></small>
        </div>
        <div ref="thread" class="chat-thread">
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
            <div>
              <div class="bubble">{{ m.content }}</div>
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
        <div class="composer-wrap">
          <div v-if="pending.length || uploading" class="att-tray">
            <span v-for="a in pending" :key="a.id" class="att-chip">
              📎 {{ a.name }} <small class="muted">{{ fmtSize(a.size) }}{{ a.textChars ? '' : ' · no text' }}</small>
              <button class="att-x" title="Remove" @click="removePending(a)">×</button>
            </span>
            <span v-if="uploading" class="muted" style="font-size: 12px">Uploading…</span>
          </div>
          <div class="composer">
            <input ref="fileInput" type="file" multiple style="display: none"
              accept=".pdf,.doc,.docx,.txt,.md,.csv,.tsv,.xlsx,.xls,.json,.log,.yaml,.yml,.xml,.html"
              @change="onFilesSelected" />
            <button class="btn" title="Attach files" :disabled="uploading" @click="triggerPick">📎</button>
            <textarea v-model="input" rows="2" placeholder="Message…  (attach PDF, Word, Excel/CSV, text)" @keydown.enter.exact.prevent="send"></textarea>
            <button class="btn primary" :disabled="sending || uploading || (!input.trim() && pending.length === 0)" @click="send">Send</button>
          </div>
        </div>
      </template>

      <!-- Project panel -->
      <div v-else-if="project" class="project-panel">
        <div class="chat-head" style="padding: 0 0 0.75rem; border-bottom: 1px solid var(--border)">
          <span>📁 {{ project.project.name }}</span>
          <div class="btn-row">
            <button class="btn primary" @click="openNew(project.project.id)">+ New chat in project</button>
            <button class="btn" @click="deleteProject(project.project)">Delete</button>
          </div>
        </div>

        <div class="panel-card">
          <h3>Project instructions</h3>
          <p class="muted" style="margin: 0; font-size: 12px">Prepended to every chat started in this project.</p>
          <textarea v-model="project.project.instructions" rows="5" placeholder="e.g. You are a compliance assistant. Always cite the source document."></textarea>
          <div class="btn-row" style="justify-content: flex-end">
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
              <button class="btn" @click="deleteDocument(d)">Remove</button>
            </span>
          </div>
          <hr style="border: none; border-top: 1px solid var(--border); margin: 0.4rem 0" />
          <div class="field"><label>Add document</label><input v-model="newDoc.name" placeholder="Document name (e.g. policy.md)" /></div>
          <textarea v-model="newDoc.content" rows="4" placeholder="Paste the document text…"></textarea>
          <div class="btn-row" style="justify-content: flex-end">
            <button class="btn primary" :disabled="docBusy || !newDoc.name.trim() || !newDoc.content.trim()" @click="addDocument">{{ docBusy ? 'Adding…' : 'Add document' }}</button>
          </div>
        </div>

        <div class="panel-card" v-if="project.conversations.length">
          <h3>Chats in this project</h3>
          <div v-for="c in project.conversations" :key="c.id" class="conv-item" @click="open(c)">{{ c.title || 'New chat' }}</div>
        </div>
      </div>

      <!-- Empty -->
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
  </div>
</template>
