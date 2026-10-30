import { describe, expect, it } from 'vitest';
import {
  ARTICLE_47_FIELD_NAME,
  pruneStaleArticle47ProfessionalAnswers,
  resolvePropertyNature,
  withArticle47ProfessionalQuestion,
} from '../../utils/vatManagement';

const baseQuestion = {
  question: 'Existing question',
  fieldName: 'existing_field',
  answerType: 'yes_no' as const,
  isRequired: true,
};

describe('Article 47 current-classification authority', () => {
  it('injects the reserved question only when currently project dependent', () => {
    const injected = withArticle47ProfessionalQuestion({
      article47Classification: 'project_dependent',
      professionalVatQuestions: [baseQuestion],
    });
    expect(injected.some((question) => question.fieldName === ARTICLE_47_FIELD_NAME)).toBe(true);

    for (const classification of ['movable', 'immovable', undefined]) {
      const served = withArticle47ProfessionalQuestion({
        article47Classification: classification,
        professionalVatQuestions: [baseQuestion],
      });
      expect(served.some((question) => question.fieldName === ARTICLE_47_FIELD_NAME)).toBe(false);
      expect(served).toHaveLength(1);
    }
  });

  it('removes a previously persisted reserved question when classification changed', () => {
    const stalePersisted = withArticle47ProfessionalQuestion({
      article47Classification: 'project_dependent',
      professionalVatQuestions: [baseQuestion],
    });
    expect(stalePersisted).toHaveLength(2);

    // Classification flipped to immovable: the reserved question disappears
    // from the served list even though it is still in the stored array.
    const served = withArticle47ProfessionalQuestion({
      article47Classification: 'immovable',
      professionalVatQuestions: stalePersisted,
    });
    expect(served.some((question) => question.fieldName === ARTICLE_47_FIELD_NAME)).toBe(false);
    expect(served).toEqual([baseQuestion]);
  });

  it('prunes stale reserved answers against the current classification only', () => {
    const answers = [
      { fieldName: ARTICLE_47_FIELD_NAME, value: true },
      { fieldName: 'unrelated_field', value: 'kept' },
    ];
    expect(pruneStaleArticle47ProfessionalAnswers(answers, 'project_dependent')).toEqual(answers);

    for (const classification of ['movable', 'immovable', 'unknown-shape', undefined]) {
      const pruned = pruneStaleArticle47ProfessionalAnswers(answers, classification);
      expect(pruned).toEqual([{ fieldName: 'unrelated_field', value: 'kept' }]);
    }
    expect(pruneStaleArticle47ProfessionalAnswers(undefined, 'movable')).toEqual([]);
  });

  it('ignores the reserved professional answer unless currently project dependent', () => {
    const professionalAnswers = { [ARTICLE_47_FIELD_NAME]: true };
    expect(resolvePropertyNature({ classification: 'project_dependent', professionalAnswers })).toBe('immovable');
    expect(resolvePropertyNature({ classification: 'movable', professionalAnswers })).toBe('movable');
    expect(resolvePropertyNature({ classification: 'immovable', professionalAnswers })).toBe('immovable');
  });
});
