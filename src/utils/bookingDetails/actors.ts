import User from '../../models/user';
import { SYSTEM_USER_ID } from '../../constants/system';
import { referenceId } from './attachments';
import { isAnonymizedAccount, maskAnonymizedUser } from '../accountAnonymity';
import type { ActorDto, DetailsViewerRole } from './types';

export interface ActorRecord {
  id: string;
  name: string | null;
  username: string | null;
  email: string | null;
  role: 'customer' | 'professional' | 'admin' | 'unknown';
  companyName: string | null;
  isAnonymized: boolean;
}

export type ActorMap = Map<string, ActorRecord>;

const idOf = (value: any): string | null => {
  const id = referenceId(value);
  return id || null;
};

export const collectActorIds = (...values: any[]): string[] => {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: any, depth = 0) => {
    if (value == null || depth > 8) return;
    if (typeof value === 'string' || typeof value === 'number') {
      if (/^[a-f0-9]{24}$/i.test(String(value))) ids.add(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
      const directId = idOf(value);
      if (directId && /^[a-f0-9]{24}$/i.test(directId)) ids.add(directId);
      for (const key of Object.keys(value)) {
        // Skip Mongoose internals and binary/date wrappers.
        if (key.startsWith('$') || key === '_doc' || key === 'buffer') continue;
        visit((value as any)[key], depth + 1);
      }
    }
  };
  values.forEach((value) => visit(value));
  return [...ids];
};

export const loadActorMap = async (ids: string[]): Promise<ActorMap> => {
  const unique = [...new Set(ids.filter((id) => /^[a-f0-9]{24}$/i.test(id)))];
  if (unique.length === 0) return new Map();
  const users = await User.find({ _id: { $in: unique } })
    .select('_id name username email role businessInfo.companyName isAnonymized deletedAt')
    .lean();
  const map: ActorMap = new Map();
  for (const raw of users as any[]) {
    const user = maskAnonymizedUser(raw);
    const role =
      user.role === 'admin' || user.role === 'professional' ? user.role : 'customer';
    map.set(String(user._id), {
      id: String(user._id),
      name: user.name || user.username || null,
      username: user.username || null,
      email: user.email || null,
      role,
      companyName: user.businessInfo?.companyName || null,
      isAnonymized: isAnonymizedAccount(raw),
    });
  }
  return map;
};

export const actorForId = (
  id: any,
  actors: ActorMap,
  viewerRole: DetailsViewerRole,
  options: {
    roleHint?: ActorDto['role'];
    source?: ActorDto['source'];
    fallbackName?: string | null;
  } = {},
): ActorDto | null => {
  const key = idOf(id);
  if (!key) {
    if (options.roleHint === 'system') {
      return { id: null, role: 'system', name: null, source: options.source || 'system_job' };
    }
    return null;
  }
  // System jobs write the zero ObjectId into updatedBy. It is a recorded actor,
  // not an unknown person: never surface the raw id or count it as unidentified.
  if (key === SYSTEM_USER_ID.toString()) {
    return { id: null, role: 'system', name: null, source: options.source || 'system_job' };
  }
  const record = actors.get(key);
  const role = record?.role || options.roleHint || 'unknown';
  const showIdentity = viewerRole === 'admin' || role !== 'admin';
  return {
    id: showIdentity ? key : null,
    role,
    name: record?.name ?? options.fallbackName ?? null,
    ...(viewerRole === 'admin' && record?.email && !record.isAnonymized
      ? { email: record.email }
      : {}),
    ...(record?.isAnonymized ? { isAnonymized: true } : {}),
    source: options.source || 'recorded',
  };
};

export const systemActor = (source: ActorDto['source'] = 'system_job'): ActorDto => ({
  id: null,
  role: 'system',
  name: null,
  source,
});

export const inferredActor = (role: 'customer' | 'professional'): ActorDto => ({
  id: null,
  role,
  name: null,
  source: 'inferred_route',
});

export const isActorRecorded = (actor: ActorDto | null): boolean =>
  Boolean(actor && actor.source !== 'inferred_route' && actor.source !== 'not_recorded');
