import { describe, expect, it } from 'vitest';
import {
  isRelevanceSort,
  scoreProjectRelevance,
  sortProjectsByRelevance,
} from '../../utils/search/projectRelevance';

const levelRankOf = (name: string | null | undefined) => {
  const rank: Record<string, number> = { 'Level 1': 2, 'Level 2': 3, 'Level 3': 4, Expert: 5 };
  return (name && rank[name]) || 0;
};

const project = (id: string, overrides: Record<string, any> = {}) => ({
  _id: id,
  title: 'Generic project',
  description: 'Standard work',
  category: 'Home',
  service: 'Plumbing',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('isRelevanceSort', () => {
  it('treats a missing sort as relevance and keeps explicit sorts unchanged', () => {
    expect(isRelevanceSort(undefined)).toBe(true);
    expect(isRelevanceSort('')).toBe(true);
    expect(isRelevanceSort('relevance')).toBe(true);
    expect(isRelevanceSort('most_relevant')).toBe(true);
    expect(isRelevanceSort('newest')).toBe(false);
    expect(isRelevanceSort('popularity')).toBe(false);
    expect(isRelevanceSort('price_asc')).toBe(false);
  });
});

describe('scoreProjectRelevance', () => {
  it('rewards keyword, service and category matches', () => {
    const base = { professional: null, rating: null, signals: { levelRankOf } };
    const unrelated = scoreProjectRelevance(project('a'), null, null, { levelRankOf });
    const keyword = scoreProjectRelevance(
      project('b', { title: 'Emergency plumbing repair' }),
      null,
      null,
      { query: 'plumbing', levelRankOf },
    );
    expect(keyword).toBeGreaterThan(unrelated);

    const categoryMatch = scoreProjectRelevance(project('c'), null, null, {
      category: 'Home',
      levelRankOf,
    });
    expect(categoryMatch).toBeGreaterThan(unrelated);

    const serviceMatch = scoreProjectRelevance(project('d', { service: 'Electrical' }), null, null, {
      services: ['Electrical'],
      levelRankOf,
    });
    const serviceMiss = scoreProjectRelevance(project('e', { service: 'Plumbing' }), null, null, {
      services: ['Electrical'],
      levelRankOf,
    });
    expect(serviceMatch).toBeGreaterThan(serviceMiss);
    void base;
  });

  it('rewards professional level, admin tags, rating and review count', () => {
    const junior = scoreProjectRelevance(project('a'), { professionalLevel: 'Level 1', adminTags: [] }, { avgRating: 3, totalReviews: 1 }, { levelRankOf });
    const senior = scoreProjectRelevance(project('b'), { professionalLevel: 'Expert', adminTags: ['Verified', 'Top'] }, { avgRating: 4.8, totalReviews: 60 }, { levelRankOf });
    expect(senior).toBeGreaterThan(junior);
  });
});

describe('sortProjectsByRelevance', () => {
  it('differs from newest-first and ranks better matches first', () => {
    const newerWeak = project('507f1f77bcf86cd799439099', {
      title: 'Unrelated garden work',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const olderStrong = project('507f1f77bcf86cd799439010', {
      title: 'Bathroom plumbing renovation',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const entries = [
      {
        project: newerWeak,
        professional: { professionalLevel: 'Level 1', adminTags: [] },
        rating: { avgRating: 3, totalReviews: 1 },
      },
      {
        project: olderStrong,
        professional: { professionalLevel: 'Expert', adminTags: ['Verified'] },
        rating: { avgRating: 4.9, totalReviews: 80 },
      },
    ];

    // Newest-first would put the garden project first.
    const newestFirst = [...entries].sort(
      (a, b) => +new Date(b.project.createdAt) - +new Date(a.project.createdAt),
    );
    expect(newestFirst[0].project._id).toBe(newerWeak._id);

    const ranked = sortProjectsByRelevance(entries, { query: 'plumbing', levelRankOf });
    expect(ranked[0].project._id).toBe(olderStrong._id);
    expect(ranked[1].project._id).toBe(newerWeak._id);
  });

  it('breaks exact score ties deterministically by id', () => {
    const first = project('507f1f77bcf86cd799439010');
    const second = project('507f1f77bcf86cd799439011');
    const forward = sortProjectsByRelevance(
      [
        { project: second, professional: null, rating: null },
        { project: first, professional: null, rating: null },
      ],
      { levelRankOf },
    );
    const backward = sortProjectsByRelevance(
      [
        { project: first, professional: null, rating: null },
        { project: second, professional: null, rating: null },
      ],
      { levelRankOf },
    );
    expect(forward.map((entry) => entry.project._id)).toEqual([first._id, second._id]);
    expect(backward.map((entry) => entry.project._id)).toEqual([first._id, second._id]);
  });

  it('prefers higher ratings when scores are otherwise equal', () => {
    const low = { project: project('507f1f77bcf86cd799439020'), professional: null, rating: { avgRating: 3, totalReviews: 50 } };
    const high = { project: project('507f1f77bcf86cd799439021'), professional: null, rating: { avgRating: 5, totalReviews: 50 } };
    // Same title/signals; rating term decides.
    const ranked = sortProjectsByRelevance([low, high], { levelRankOf });
    expect(ranked[0].project._id).toBe(high.project._id);
  });
});
