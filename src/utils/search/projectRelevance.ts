/**
 * "Most relevant" project ranking (client bug list #4a).
 *
 * The default project sort used to be plain newest-first, which made the
 * "Most relevant" option meaningless. This module scores every candidate in
 * memory from signals the search handler already loaded:
 * professional level, admin tags, keyword / service / category match, average
 * rating and review count — with fully deterministic tie-breakers so
 * pagination stays consistent (sort happens before the slice, total counts
 * are computed on the sorted set).
 *
 * Pure functions: no DB access, easy to unit test.
 */

export interface RelevanceProfessional {
  professionalLevel?: string | null;
  adminTags?: unknown;
}

export interface RelevanceRating {
  avgRating?: number | null;
  totalReviews?: number | null;
}

export interface RelevanceSignals {
  /** Raw search query (tokenized internally). */
  query?: string;
  /** Exact category filter value, when provided. */
  category?: string;
  /** Service filter values, when provided. */
  services?: string[];
  /** Higher return value = more senior level. Unknown levels score 0. */
  levelRankOf?: (levelName: string | null | undefined) => number;
}

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const tokenize = (query: string): string[] => {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  return Array.from(new Set(tokens)).slice(0, 10);
};

const serviceNamesOf = (project: any): string[] => {
  const names: string[] = [];
  if (typeof project?.service === 'string' && project.service.trim()) {
    names.push(project.service);
  }
  for (const entry of Array.isArray(project?.services) ? project.services : []) {
    const name = typeof entry === 'string'
      ? entry
      : entry?.name || entry?.service || entry?.serviceName;
    if (typeof name === 'string' && name.trim()) names.push(name);
  }
  return names;
};

/**
 * Deterministic relevance score for one project. Higher is better.
 * Weights are documented so the frontend can explain the order:
 * keyword 5/4/3/2 · category filter 6 · service filter 4/2 · level ≤6 ·
 * admin tags ≤3 · rating ≤6 · reviews ≤4.
 */
export const scoreProjectRelevance = (
  project: any,
  professional: RelevanceProfessional | null | undefined,
  rating: RelevanceRating | null | undefined,
  signals: RelevanceSignals,
): number => {
  let score = 0;

  const title = normalize(project?.title);
  const description = normalize(project?.description);
  const category = normalize(project?.category);
  const service = normalize(project?.service);
  const areaOfWork = normalize(project?.areaOfWork);
  const services = serviceNamesOf(project).map(normalize);

  for (const token of tokenize(signals.query || '')) {
    if (title.includes(token)) score += 5;
    if (service.includes(token)) score += 4;
    if (category.includes(token)) score += 3;
    if (description.includes(token)) score += 2;
    if (areaOfWork.includes(token)) score += 1;
  }

  const categoryFilter = normalize(signals.category);
  if (categoryFilter && category === categoryFilter) score += 6;

  const serviceFilters = (signals.services || []).map(normalize).filter(Boolean);
  if (serviceFilters.length > 0) {
    if (serviceFilters.includes(service)) {
      score += 4;
    } else if (services.some((name) => serviceFilters.includes(name))) {
      score += 2;
    }
  }

  const rank = signals.levelRankOf?.(professional?.professionalLevel ?? null) ?? 0;
  if (Number.isFinite(rank) && rank > 0) score += Math.min(rank, 6);

  const tagCount = Array.isArray(professional?.adminTags) ? professional.adminTags.length : 0;
  score += Math.min(tagCount, 5) * 0.6;

  const avgRating = Number(rating?.avgRating) || 0;
  if (avgRating > 0) score += Math.min(avgRating, 5) * 1.2;

  const totalReviews = Number(rating?.totalReviews) || 0;
  if (totalReviews > 0) score += Math.min(totalReviews, 100) / 25;

  return Math.round(score * 1000) / 1000;
};

export interface RelevanceRankInput {
  project: any;
  professional?: RelevanceProfessional | null;
  rating?: RelevanceRating | null;
}

const idOf = (project: any): string => {
  const raw = project?._id;
  if (raw == null) return '';
  return typeof raw === 'string' ? raw : String(raw);
};

const ratingOf = (entry: RelevanceRankInput): { avg: number; count: number } => ({
  avg: Number(entry.rating?.avgRating) || 0,
  count: Number(entry.rating?.totalReviews) || 0,
});

/**
 * Sort candidates by relevance (descending). Tie-breakers are deterministic
 * and intentionally independent of creation date so the order differs from
 * "Newest first": score → average rating → review count → id.
 */
export const sortProjectsByRelevance = (
  entries: RelevanceRankInput[],
  signals: RelevanceSignals,
): RelevanceRankInput[] =>
  entries
    .map((entry) => ({
      entry,
      score: scoreProjectRelevance(entry.project, entry.professional, entry.rating, signals),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ra = ratingOf(a.entry);
      const rb = ratingOf(b.entry);
      if (rb.avg !== ra.avg) return rb.avg - ra.avg;
      if (rb.count !== ra.count) return rb.count - ra.count;
      return idOf(a.entry.project).localeCompare(idOf(b.entry.project));
    })
    .map(({ entry }) => entry);

/** Values that select the relevance ranking (default when sort is omitted). */
const RELEVANCE_SORT_VALUES = new Set([
  '',
  'relevance',
  'relevant',
  'most_relevant',
  'most-relevant',
  'most relevant',
  'default',
]);

export const isRelevanceSort = (sortBy: unknown): boolean =>
  sortBy == null || RELEVANCE_SORT_VALUES.has(String(sortBy).trim().toLowerCase());
