<script lang="ts">
export interface GroupListMeta {
  name: string;
  iconId?: string;
}
</script>

<script setup lang="ts" generic="T extends { groupId: string }">
import { computed, ref } from 'vue';
import { ChevronRight } from 'lucide-vue-next';
import IntegrationIcon from './IntegrationIcon.vue';

const props = withDefaults(
  defineProps<{
    items: T[];
    /** Metadata per groupId (server name + brand-icon id). Missing → groupId shown raw. */
    groups?: Record<string, GroupListMeta>;
    /** Noun for empty/search copy, e.g. "tool". */
    noun?: string;
    /** Text to match a row against when searching. Defaults to JSON of the item. */
    searchText?: (item: T) => string;
    /** Whether groups start expanded (browse) or collapsed. */
    defaultExpanded?: boolean;
    emptyText?: string;
  }>(),
  { noun: 'item', defaultExpanded: true },
);

const search = ref('');
const overrides = ref<Record<string, boolean>>({});

interface GroupView {
  groupId: string;
  name: string;
  iconId?: string;
  items: T[];
  total: number;
}

const groupViews = computed<GroupView[]>(() => {
  const q = search.value.trim().toLowerCase();
  const totals = new Map<string, number>();
  const buckets = new Map<string, T[]>();
  for (const it of props.items) {
    totals.set(it.groupId, (totals.get(it.groupId) ?? 0) + 1);
    if (q) {
      const gname = (props.groups?.[it.groupId]?.name ?? it.groupId).toLowerCase();
      const hay = (props.searchText ? props.searchText(it) : JSON.stringify(it)).toLowerCase();
      if (!hay.includes(q) && !gname.includes(q)) continue;
    }
    const arr = buckets.get(it.groupId);
    if (arr) arr.push(it);
    else buckets.set(it.groupId, [it]);
  }
  const views: GroupView[] = [];
  for (const [groupId, items] of buckets) {
    const meta = props.groups?.[groupId];
    views.push({ groupId, name: meta?.name ?? groupId, iconId: meta?.iconId, items, total: totals.get(groupId) ?? items.length });
  }
  return views.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
});

const filtering = computed(() => !!search.value.trim());

function isExpanded(groupId: string): boolean {
  if (filtering.value) return true; // while searching, matching groups are force-open
  return overrides.value[groupId] ?? props.defaultExpanded;
}
function toggle(groupId: string): void {
  if (filtering.value) return;
  overrides.value = { ...overrides.value, [groupId]: !isExpanded(groupId) };
}
function setAll(open: boolean): void {
  const next: Record<string, boolean> = {};
  for (const g of groupViews.value) next[g.groupId] = open;
  overrides.value = next;
}
</script>

<template>
  <div class="gl">
    <div class="gl-toolbar">
      <input v-model="search" class="gl-search" :placeholder="`Search ${noun}s…`" />
      <span class="gl-actions">
        <button type="button" class="gl-link" @click="setAll(true)" :disabled="filtering">Expand all</button>
        <button type="button" class="gl-link" @click="setAll(false)" :disabled="filtering">Collapse all</button>
      </span>
    </div>

    <div v-if="items.length === 0" class="gl-empty">{{ emptyText || `No ${noun}s yet.` }}</div>
    <div v-else-if="groupViews.length === 0" class="gl-empty">No {{ noun }}s match “{{ search }}”.</div>

    <div v-for="g in groupViews" :key="g.groupId" class="gl-group">
      <div class="gl-head" role="button" tabindex="0" @click="toggle(g.groupId)" @keydown.enter="toggle(g.groupId)">
        <ChevronRight class="gl-chev" :class="{ open: isExpanded(g.groupId) }" :size="15" />
        <IntegrationIcon :id="g.iconId" :name="g.name" :size="20" />
        <span class="gl-gname">{{ g.name }}</span>
        <span class="gl-count">{{ filtering && g.items.length !== g.total ? `${g.items.length}/${g.total}` : g.total }}</span>
      </div>
      <div v-show="isExpanded(g.groupId)" class="gl-rows">
        <div v-for="(it, i) in g.items" :key="i" class="gl-row">
          <slot name="row" :item="it" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gl {
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 8px);
  background: var(--bg-surface);
  overflow: hidden;
}
.gl-toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.gl-search { flex: 1 1 200px; min-width: 140px; margin: 0; }
.gl-actions { display: inline-flex; gap: 0.6rem; }
.gl-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent, var(--brand));
  font-size: 0.8rem;
  cursor: pointer;
}
.gl-link:disabled { color: var(--text-faint); cursor: default; }
.gl-empty { padding: 1rem; color: var(--text-muted); font-size: 0.88rem; }

.gl-group { border-bottom: 1px solid var(--border); }
.gl-group:last-child { border-bottom: none; }
.gl-head {
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
.gl-head:hover { background: var(--hover); }
.gl-chev { color: var(--text-muted); transition: transform 0.12s ease; flex: 0 0 auto; }
.gl-chev.open { transform: rotate(90deg); }
.gl-gname { font-weight: 600; font-size: 0.9rem; }
.gl-count {
  margin-left: auto;
  font-size: 0.72rem;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.gl-rows { background: var(--bg-page); }
.gl-row {
  padding: 0.4rem 0.6rem 0.4rem 1.9rem;
  border-top: 1px solid var(--border);
}
.gl-row:first-child { border-top: none; }
</style>
