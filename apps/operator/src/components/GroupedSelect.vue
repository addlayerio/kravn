<script lang="ts">
/** One selectable row. `groupId` buckets it under a server/origin; `id` is what gets stored. */
export interface GroupedItem {
  id: string;
  groupId: string;
  label: string;
  sublabel?: string;
  tag?: string;
}
export interface GroupMeta {
  name: string;
  iconId?: string;
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight } from 'lucide-vue-next';
import IntegrationIcon from './IntegrationIcon.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    items: GroupedItem[];
    /** Metadata per groupId (server name + brand-icon id). Missing → groupId shown raw. */
    groups?: Record<string, GroupMeta>;
    /** Already-localized PLURAL noun for empty/summary copy, e.g. "tools". */
    noun?: string;
    disabled?: boolean;
    emptyText?: string;
  }>(),
  { noun: 'items', disabled: false, emptyText: '' },
);

const model = defineModel<string[]>({ required: true });

const search = ref('');
const onlySelected = ref(false);
const expanded = ref<Record<string, boolean>>({});
const seeded = ref(false);

const selectedSet = computed(() => new Set(model.value));
const itemIdSet = computed(() => new Set(props.items.map((i) => i.id)));
const isSel = (id: string) => selectedSet.value.has(id);

interface GroupView {
  groupId: string;
  name: string;
  iconId?: string;
  all: GroupedItem[];
  visible: GroupedItem[];
  selectedCount: number;
  allSelected: boolean;
  someSelected: boolean;
}

const groupViews = computed<GroupView[]>(() => {
  const q = search.value.trim().toLowerCase();
  const buckets = new Map<string, GroupedItem[]>();
  for (const it of props.items) {
    const arr = buckets.get(it.groupId);
    if (arr) arr.push(it);
    else buckets.set(it.groupId, [it]);
  }
  const views: GroupView[] = [];
  for (const [groupId, all] of buckets) {
    const meta = props.groups?.[groupId];
    const name = meta?.name ?? groupId;
    const matchesQ = (i: GroupedItem) =>
      !q ||
      i.label.toLowerCase().includes(q) ||
      (i.sublabel ?? '').toLowerCase().includes(q) ||
      name.toLowerCase().includes(q);
    const visible = all
      .filter((i) => (onlySelected.value ? isSel(i.id) : true))
      .filter(matchesQ)
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    // Hide a group with no visible rows only when a filter is actually narrowing the list.
    if ((q || onlySelected.value) && visible.length === 0) continue;
    const selectedCount = all.reduce((n, i) => n + (isSel(i.id) ? 1 : 0), 0);
    views.push({
      groupId,
      name,
      iconId: meta?.iconId,
      all,
      visible,
      selectedCount,
      allSelected: all.length > 0 && selectedCount === all.length,
      someSelected: selectedCount > 0,
    });
  }
  return views.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
});

const totalSelected = computed(() => model.value.filter((id) => itemIdSet.value.has(id)).length);
// Distinct origin groups among the selection — derived from items (NOT groupViews), so search/filter
// state never changes the count.
const serversWithSelection = computed(() => {
  const groups = new Set<string>();
  for (const it of props.items) if (selectedSet.value.has(it.id)) groups.add(it.groupId);
  return groups.size;
});
const filtering = computed(() => !!search.value.trim() || onlySelected.value);

function isExpanded(groupId: string): boolean {
  return filtering.value || expanded.value[groupId] === true;
}
function toggleExpand(groupId: string): void {
  if (filtering.value) return; // while filtering, groups are force-open
  expanded.value = { ...expanded.value, [groupId]: !expanded.value[groupId] };
}
function expandAll(): void {
  const next: Record<string, boolean> = {};
  for (const g of groupViews.value) next[g.groupId] = true;
  expanded.value = next;
}
function collapseAll(): void {
  expanded.value = {};
}

function toggleItem(id: string): void {
  if (props.disabled) return;
  model.value = isSel(id) ? model.value.filter((x) => x !== id) : [...model.value, id];
}
function toggleGroup(g: GroupView): void {
  if (props.disabled) return;
  const ids = g.all.map((i) => i.id);
  if (g.allSelected) {
    const drop = new Set(ids);
    model.value = model.value.filter((x) => !drop.has(x));
  } else {
    const have = selectedSet.value;
    model.value = [...model.value, ...ids.filter((id) => !have.has(id))];
  }
}
function clearAll(): void {
  if (props.disabled) return;
  model.value = model.value.filter((id) => !itemIdSet.value.has(id));
}

// Auto-expand groups that already have a selection the first time items arrive (so opening an
// existing endpoint shows what's picked without hunting). User toggles win afterwards.
watch(
  () => props.items.length,
  (len) => {
    if (seeded.value || len === 0) return;
    seeded.value = true;
    const next: Record<string, boolean> = {};
    for (const g of groupViews.value) if (g.someSelected) next[g.groupId] = true;
    expanded.value = next;
  },
  { immediate: true },
);

// Directive: reflect tri-state on the native checkbox (Vue can't bind `indeterminate` declaratively).
const vIndeterminate = {
  mounted: (el: HTMLInputElement, b: { value: boolean }) => (el.indeterminate = b.value),
  updated: (el: HTMLInputElement, b: { value: boolean }) => (el.indeterminate = b.value),
};
</script>

<template>
  <div class="gs">
    <div class="gs-toolbar">
      <input v-model="search" class="gs-search" :placeholder="t('grouped.searchNoun', { noun })" />
      <label class="gs-only" :class="{ active: onlySelected }">
        <input type="checkbox" v-model="onlySelected" />
        {{ t('grouped.onlySelected') }}
      </label>
      <span class="gs-actions">
        <button type="button" class="gs-link" @click="expandAll" :disabled="filtering">{{ t('grouped.expandAll') }}</button>
        <button type="button" class="gs-link" @click="collapseAll" :disabled="filtering">{{ t('grouped.collapseAll') }}</button>
      </span>
    </div>

    <div class="gs-scroll">
      <div v-if="items.length === 0" class="gs-empty">{{ emptyText || t('grouped.noItemsAvailable', { noun }) }}</div>
      <div v-else-if="groupViews.length === 0" class="gs-empty">{{ t('grouped.noMatch', { noun, q: search }) }}</div>

      <div v-for="g in groupViews" :key="g.groupId" class="gs-group">
        <div class="gs-head" role="button" tabindex="0" @click="toggleExpand(g.groupId)" @keydown.enter="toggleExpand(g.groupId)">
          <ChevronRight class="gs-chev" :class="{ open: isExpanded(g.groupId) }" :size="15" />
          <IntegrationIcon :id="g.iconId" :name="g.name" :size="20" />
          <span class="gs-gname">{{ g.name }}</span>
          <span class="gs-count" :class="{ some: g.someSelected }">{{ g.selectedCount }}/{{ g.all.length }}</span>
          <input
            class="gs-master"
            type="checkbox"
            :checked="g.allSelected"
            v-indeterminate="g.someSelected && !g.allSelected"
            :disabled="disabled"
            :title="g.allSelected ? t('grouped.clearAllIn', { name: g.name }) : t('grouped.selectAllIn', { name: g.name })"
            @click.stop
            @change="toggleGroup(g)"
          />
        </div>

        <div v-show="isExpanded(g.groupId)" class="gs-rows">
          <label v-for="it in g.visible" :key="it.id" class="gs-row" :class="{ on: isSel(it.id) }">
            <input type="checkbox" :checked="isSel(it.id)" :disabled="disabled" @change="toggleItem(it.id)" />
            <span class="gs-label">
              {{ it.label }}
              <small v-if="it.tag" class="gs-tag">{{ it.tag }}</small>
            </span>
            <small v-if="it.sublabel && it.sublabel !== it.label" class="gs-sub">{{ it.sublabel }}</small>
          </label>
        </div>
      </div>
    </div>

    <div class="gs-summary">
      <span><strong>{{ totalSelected }}</strong> {{ t('grouped.nounSelectedSuffix', { noun }) }}<template v-if="serversWithSelection"> · {{ t('grouped.serverCount', { count: serversWithSelection }, serversWithSelection) }}</template></span>
      <button v-if="totalSelected > 0 && !disabled" type="button" class="gs-link" @click="clearAll">{{ t('grouped.clearAll') }}</button>
    </div>
  </div>
</template>

<style scoped>
.gs {
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  background: var(--bg-surface);
  overflow: hidden;
}
.gs-toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.gs-search {
  flex: 1 1 180px;
  min-width: 140px;
  margin: 0;
}
.gs-only {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
}
.gs-only input { width: auto; margin: 0; }
.gs-only.active { color: var(--text); }
.gs-actions { display: inline-flex; gap: 0.6rem; }
.gs-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent, var(--brand));
  font-size: 0.8rem;
  cursor: pointer;
}
.gs-link:disabled { color: var(--text-faint); cursor: default; }

.gs-scroll { max-height: 340px; overflow: auto; }
.gs-empty { padding: 1rem; color: var(--text-muted); font-size: 0.88rem; }

.gs-group { border-bottom: 1px solid var(--border); }
.gs-group:last-child { border-bottom: none; }
.gs-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.6rem;
  background: var(--bg-surface);
  cursor: pointer;
  user-select: none;
}
.gs-head:hover { background: var(--hover); }
.gs-chev { color: var(--text-muted); transition: transform 0.12s ease; flex: 0 0 auto; }
.gs-chev.open { transform: rotate(90deg); }
.gs-gname { font-weight: 600; font-size: 0.9rem; }
.gs-count {
  margin-left: auto;
  font-size: 0.72rem;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.gs-count.some { color: var(--text-muted); }
.gs-master { width: auto; margin: 0; flex: 0 0 auto; }

.gs-rows { padding: 0.15rem 0 0.35rem; background: var(--bg-page); }
.gs-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.28rem 0.6rem 0.28rem 1.9rem;
  font-weight: 400;
  cursor: pointer;
}
.gs-row:hover { background: var(--hover); }
.gs-row input { width: auto; margin: 0; flex: 0 0 auto; }
.gs-label { font-size: 0.86rem; white-space: nowrap; }
.gs-row.on .gs-label { font-weight: 600; }
.gs-tag {
  color: var(--text-faint);
  font-weight: 400;
  margin-left: 0.3rem;
}
.gs-sub {
  color: var(--text-muted);
  font-size: 0.78rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.gs-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.45rem 0.7rem;
  border-top: 1px solid var(--border);
  font-size: 0.8rem;
  color: var(--text-muted);
}
</style>
