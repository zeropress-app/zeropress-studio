import {
  createContext,
  useContext,
  useEffect,
  type ReactNode,
} from 'react';

const StudioSiteTitleContext = createContext('');
const StudioSiteUrlContext = createContext('');

export function useStudioSiteUrl() { return useContext(StudioSiteUrlContext); }

export type StudioSiteIdentity = {
  title: string;
  url: string;
};

export function formatStudioDocumentTitle(
  documentTitle: string,
  siteTitle: string,
): string {
  return siteTitle ? `${siteTitle} — ${documentTitle}` : documentTitle;
}

export function StudioSiteIdentityProvider(input: {
  siteTitle: string;
  siteUrl?: string;
  children: ReactNode;
}) {
  return (
    <StudioSiteTitleContext.Provider value={input.siteTitle}>
      <StudioSiteUrlContext.Provider value={input.siteUrl ?? ''}>
        {input.children}
      </StudioSiteUrlContext.Provider>
    </StudioSiteTitleContext.Provider>
  );
}

/**
 * Browser document titles for authenticated Studio screens.
 *
 * Each screen owns its translated "... · ZeroPress Studio" title. This hook prefixes the current
 * site title so browser tabs distinguish Studio installations. Standalone screens and tests
 * outside the provider retain their existing titles.
 */
export function useStudioDocumentTitle(documentTitle: string) {
  const siteTitle = useContext(StudioSiteTitleContext);
  useEffect(() => {
    document.title = formatStudioDocumentTitle(documentTitle, siteTitle);
  }, [documentTitle, siteTitle]);
}
