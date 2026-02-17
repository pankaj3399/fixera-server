export const NO_PREVIOUS_VALUE = "(none)";

export type PendingIdChange = {
  field: string;
  oldValue: string;
  newValue: string;
};

type PendingIdChangeInput =
  | {
      field?: string;
      oldValue?: string | null;
      newValue?: string;
    }
  | null
  | undefined;

export const normalizePendingIdChanges = (
  pendingIdChanges?: PendingIdChangeInput[] | null
): PendingIdChange[] | undefined => {
  if (!Array.isArray(pendingIdChanges)) {
    return undefined;
  }

  const normalizedPendingChanges = pendingIdChanges
    .filter((change) => !!change?.field && !!change?.newValue)
    .map((change) => ({
      field: change!.field as string,
      oldValue: (change!.oldValue || "").trim() || NO_PREVIOUS_VALUE,
      newValue: change!.newValue as string,
    }));

  return normalizedPendingChanges.length > 0
    ? normalizedPendingChanges
    : undefined;
};

export const normalizePendingOldValue = (
  value?: string | null
): string | undefined => {
  const normalized = value?.trim();
  if (!normalized || normalized === NO_PREVIOUS_VALUE) {
    return undefined;
  }
  return normalized;
};
