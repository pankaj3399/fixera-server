import type { IUser } from '../models/user';

type ProfessionalLike =
  | (Pick<IUser, 'name'> & { username?: string; businessInfo?: { companyName?: string } })
  | null
  | undefined;

export function getProfessionalDisplayName(
  user: ProfessionalLike,
  fallback: string = 'Professional'
): string {
  const username = user?.username?.trim();
  if (username) return username;
  const name = user?.name?.trim();
  if (name) return name;
  return fallback;
}
