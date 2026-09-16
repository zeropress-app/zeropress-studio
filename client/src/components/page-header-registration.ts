import { createContext } from 'react';

/**
 * PageHeader information rendered by the current route.
 *
 * The topbar displays the registered title and description directly. Keeping no separate title in
 * route metadata prevents translation and copy drift.
 */
export type PageHeaderRegistration = {
  id: symbol;
  titleId: string;
  title: string;
  description?: string;
};

export type PageHeaderRegistry = {
  register: (registration: PageHeaderRegistration) => void;
  unregister: (id: symbol) => void;
};

export const PageHeaderRegistrationContext =
  createContext<PageHeaderRegistry | null>(null);
