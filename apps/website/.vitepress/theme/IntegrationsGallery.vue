<script setup lang="ts">
import { computed, ref } from 'vue';
import { data, type GalleryItem } from '../integrations.data';

const props = withDefaults(defineProps<{ featured?: boolean }>(), { featured: false });

const search = ref('');
const category = ref('');
const kind = ref<'' | 'built-in' | 'catalog'>('');

const KINDS = [
  { value: '' as const, label: 'All', count: data.total },
  { value: 'built-in' as const, label: 'Built-in', count: data.builtInCount },
  { value: 'catalog' as const, label: 'Catalog', count: data.catalogCount },
];

const featuredItems = computed<GalleryItem[]>(() => {
  const byId = new Map(data.items.map((i) => [i.id, i]));
  return data.featured.map((id) => byId.get(id)).filter((x): x is GalleryItem => !!x);
});

const filtered = computed<GalleryItem[]>(() => {
  const q = search.value.trim().toLowerCase();
  return data.items.filter(
    (i) =>
      (!kind.value || i.kind === kind.value) &&
      (!category.value || i.category === category.value) &&
      (!q ||
        i.name.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q)),
  );
});

const shown = computed(() => (props.featured ? featuredItems.value : filtered.value));

const authLabel: Record<string, string> = { open: 'No auth', apikey: 'API key', oauth: 'OAuth' };

function monogram(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  const words = name.replace(/[^\w ]/g, '').trim().split(/\s+/).filter(Boolean);
  const initials = (
    words.length >= 2 ? words[0][0] + words[1][0] : name.replace(/[^\w]/g, '').slice(0, 2) || '?'
  ).toUpperCase();
  return { initials, bg: `hsl(${h} 45% 42%)` };
}
</script>

<template>
  <div class="ig">
    <div v-if="!featured" class="ig-toolbar">
      <div class="ig-kinds" role="group" aria-label="Filter by kind">
        <button
          v-for="k in KINDS"
          :key="k.value"
          type="button"
          class="ig-chip"
          :class="{ active: kind === k.value }"
          :aria-pressed="kind === k.value"
          @click="kind = k.value"
        >
          {{ k.label }} <span class="ig-chip-n">{{ k.count }}</span>
        </button>
      </div>
      <input v-model="search" class="ig-search" placeholder="Search integrations…" aria-label="Search integrations" />
      <select v-model="category" class="ig-select" aria-label="Filter by category">
        <option value="">All categories</option>
        <option v-for="c in data.categories" :key="c" :value="c">{{ c }}</option>
      </select>
      <span class="ig-count">{{ filtered.length }} / {{ data.total }}</span>
    </div>

    <div class="ig-grid" :class="{ 'ig-grid--featured': featured }">
      <div v-for="it in shown" :key="it.id" class="ig-card" :class="{ 'ig-card--featured': featured }">
        <span class="ig-icon" :title="it.name">
          <span v-if="it.icon" class="ig-brand">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path :d="it.icon.path" :fill="it.icon.hex" /></svg>
          </span>
          <span v-else class="ig-mono" :style="{ background: monogram(it.name).bg }">{{ monogram(it.name).initials }}</span>
        </span>
        <div class="ig-body">
          <div class="ig-name">{{ it.name }}</div>
          <template v-if="!featured">
            <div class="ig-cat">{{ it.category }}</div>
            <p class="ig-desc">{{ it.description }}</p>
            <span class="ig-badge" :class="it.kind">
              {{ it.kind === 'built-in' ? 'Built-in' : authLabel[it.auth || 'open'] }}
            </span>
          </template>
        </div>
      </div>
    </div>

    <p v-if="!featured && filtered.length === 0" class="ig-empty">No integrations match “{{ search }}”.</p>

    <p v-if="featured" class="ig-more">
      <strong>{{ data.builtInCount }}</strong> built-in +
      <strong>{{ data.catalogCount }}</strong> catalog integrations —
      <a href="/integrations">browse them all →</a>
    </p>
  </div>
</template>

<style scoped>
.ig {
  margin: 1.25rem 0;
}
.ig-toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.ig-search,
.ig-select {
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.9rem;
}
.ig-search { flex: 1 1 240px; min-width: 180px; }
.ig-count { color: var(--vp-c-text-3); font-size: 0.85rem; font-variant-numeric: tabular-nums; }

.ig-kinds { display: inline-flex; gap: 0.3rem; }
.ig-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}
.ig-chip:hover { border-color: var(--vp-c-brand-1); }
.ig-chip.active {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.ig-chip-n {
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
  font-variant-numeric: tabular-nums;
}
.ig-chip.active .ig-chip-n { color: var(--vp-c-brand-1); }

.ig-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 0.75rem;
}
.ig-grid--featured {
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
}
.ig-card {
  display: flex;
  gap: 0.7rem;
  padding: 0.85rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.ig-card:hover { border-color: var(--vp-c-brand-1); transform: translateY(-2px); }
.ig-card--featured { align-items: center; padding: 0.7rem 0.85rem; }

.ig-icon { flex: 0 0 auto; }
.ig-brand,
.ig-mono {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ig-brand {
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  padding: 16%;
  box-sizing: border-box;
}
.ig-brand svg { width: 100%; height: 100%; display: block; }
.ig-mono { color: #fff; font-weight: 700; font-size: 0.8rem; }

.ig-body { min-width: 0; }
.ig-name { font-weight: 600; font-size: 0.92rem; color: var(--vp-c-text-1); }
.ig-cat { font-size: 0.75rem; color: var(--vp-c-text-3); margin-top: 0.1rem; }
.ig-desc {
  font-size: 0.8rem;
  color: var(--vp-c-text-2);
  margin: 0.35rem 0 0.5rem;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ig-badge {
  display: inline-block;
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
}
.ig-badge.built-in { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }

.ig-empty { color: var(--vp-c-text-3); text-align: center; padding: 1.5rem; }
.ig-more { color: var(--vp-c-text-2); font-size: 0.9rem; margin-top: 1rem; }
</style>
