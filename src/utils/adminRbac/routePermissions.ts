import type { AdminAccessArea, AdminPermission } from './types';

/**
 * Most-specific path prefix wins. Paths are relative to the admin router
 * (e.g. `/payments`, not `/api/admin/payments`).
 */
const ROUTE_RULES: Array<{ prefix: string; permission: AdminPermission; area: AdminAccessArea; readOnly?: boolean }> = [
  { prefix: '/staff', permission: 'staff.manage', area: 'staff' },

  { prefix: '/professionals/manage', permission: 'professionals.manage', area: 'professionals_manage' },
  { prefix: '/professionals', permission: 'professionals.approve', area: 'professionals_approve' },
  { prefix: '/stats/approvals', permission: 'professionals.approve', area: 'professionals_approve' },

  { prefix: '/customers', permission: 'customers.manage', area: 'customers' },

  { prefix: '/bookings/', permission: 'bookings.read', area: 'bookings' }, // /bookings/:id/... — writes checked by method
  { prefix: '/bookings', permission: 'bookings.read', area: 'bookings' },
  { prefix: '/disputes', permission: 'disputes.manage', area: 'disputes' },
  { prefix: '/cancellation-requests', permission: 'cancellations.manage', area: 'cancellations' },

  { prefix: '/chat-reports', permission: 'chat.reports', area: 'chat_reports' },
  { prefix: '/conversations', permission: 'chat.support', area: 'chat' },
  { prefix: '/chat/', permission: 'chat.support', area: 'chat' },

  { prefix: '/support', permission: 'support.tickets', area: 'support' },

  { prefix: '/payments', permission: 'payments.manage', area: 'payments' },
  { prefix: '/kpi', permission: 'kpi.read', area: 'kpi' },
  { prefix: '/audit-logs', permission: 'audit.read', area: 'audit' },
  { prefix: '/email-logs', permission: 'email_logs.read', area: 'email_logs' },

  { prefix: '/cms', permission: 'cms.manage', area: 'cms' },
  { prefix: '/site-announcements', permission: 'cms.manage', area: 'cms' },
  { prefix: '/marketing-campaigns', permission: 'campaigns.manage', area: 'campaigns' },
  { prefix: '/marketing-subscribers', permission: 'campaigns.manage', area: 'campaigns' },
  { prefix: '/marketing-leads', permission: 'campaigns.manage', area: 'campaigns' },
  { prefix: '/marketing-lead-imports', permission: 'campaigns.manage', area: 'campaigns' },
  { prefix: '/discount-codes', permission: 'discounts.manage', area: 'discounts' },
  { prefix: '/loyalty', permission: 'loyalty.manage', area: 'loyalty' },
  { prefix: '/points', permission: 'loyalty.manage', area: 'loyalty' },
  { prefix: '/professional-levels', permission: 'loyalty.manage', area: 'loyalty' },
  { prefix: '/referral', permission: 'referrals.manage', area: 'referrals' },
  { prefix: '/backlinks', permission: 'backlinks.manage', area: 'backlinks' },
  { prefix: '/favorites', permission: 'favorites.manage', area: 'favorites' },
  { prefix: '/reviews', permission: 'reviews.moderate', area: 'reviews' },

  { prefix: '/service-configurations', permission: 'services.manage', area: 'services' },

  { prefix: '/marketing-campaigns/preview-audience', permission: 'campaigns.manage', area: 'campaigns', readOnly: true },

  { prefix: '/platform-settings', permission: 'settings.platform', area: 'platform' },
  { prefix: '/site-settings', permission: 'settings.site', area: 'platform' },

  { prefix: '/users/', permission: 'users.delete', area: 'user_delete' },

  { prefix: '/run-', permission: 'maintenance.run', area: 'maintenance' },
];

/** Permission required for an admin-router path, or null if any authenticated admin may call it. */
export function permissionForAdminPath(path: string): AdminPermission | null {
  const normalized = path.split('?')[0] || '/';
  const matches = ROUTE_RULES.filter(
    (rule) => normalized === rule.prefix || normalized.startsWith(rule.prefix)
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.prefix.length - a.prefix.length);
  return matches[0]?.permission ?? null;
}

export function accessAreaForAdminPath(path: string): AdminAccessArea | null {
  const normalized = path.split('?')[0] || '/';
  const matches = ROUTE_RULES.filter(
    (rule) => normalized === rule.prefix || normalized.startsWith(rule.prefix)
  ).sort((a, b) => b.prefix.length - a.prefix.length);
  return matches[0]?.area ?? null;
}

export function accessRequirementForAdminPath(path: string, method: string): 'read' | 'write' {
  const normalized = path.split('?')[0] || '/';
  const matches = ROUTE_RULES.filter(
    (rule) => normalized === rule.prefix || normalized.startsWith(rule.prefix)
  ).sort((a, b) => b.prefix.length - a.prefix.length);
  return method === 'GET' || matches[0]?.readOnly ? 'read' : 'write';
}
