/**
 * Project permission keys (subset of the 48 observed in Jira, JIRA_REQUIREMENTS §4) mapped to the
 * four observed project roles. Kept as keys so permission schemes can replace this map later.
 */
export type Role = 'admin' | 'member' | 'viewer' | 'guest';

export const PERMISSIONS = [
  'BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'DELETE_ISSUES', 'ASSIGN_ISSUES', 'ASSIGNABLE_USER',
  'TRANSITION_ISSUES', 'SCHEDULE_ISSUES', 'MODIFY_REPORTER', 'LINK_ISSUES',
  'ADD_COMMENTS', 'EDIT_OWN_COMMENTS', 'EDIT_ALL_COMMENTS', 'DELETE_OWN_COMMENTS', 'DELETE_ALL_COMMENTS',
  'MANAGE_WATCHERS', 'VIEW_VOTERS_AND_WATCHERS', 'ADMINISTER_PROJECTS', 'MANAGE_SPRINTS',
  'CREATE_ATTACHMENTS', 'DELETE_OWN_ATTACHMENTS', 'DELETE_ALL_ATTACHMENTS',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MEMBER: Permission[] = [
  'BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES', 'ASSIGN_ISSUES', 'ASSIGNABLE_USER', 'TRANSITION_ISSUES',
  'SCHEDULE_ISSUES', 'LINK_ISSUES', 'ADD_COMMENTS', 'EDIT_OWN_COMMENTS', 'DELETE_OWN_COMMENTS',
  'VIEW_VOTERS_AND_WATCHERS', 'MANAGE_SPRINTS', // team-managed: members run sprints (Jira MANAGE_SPRINTS_PERMISSION)
  'CREATE_ATTACHMENTS', 'DELETE_OWN_ATTACHMENTS',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(PERMISSIONS),
  member: new Set(MEMBER),
  viewer: new Set<Permission>(['BROWSE_PROJECTS', 'VIEW_VOTERS_AND_WATCHERS']),
  guest: new Set<Permission>(['BROWSE_PROJECTS', 'ADD_COMMENTS', 'EDIT_OWN_COMMENTS', 'DELETE_OWN_COMMENTS']),
};

export function can(role: Role | null | undefined, perm: Permission, siteAdmin = false): boolean {
  if (siteAdmin) return true;
  return !!role && ROLE_PERMISSIONS[role].has(perm);
}
