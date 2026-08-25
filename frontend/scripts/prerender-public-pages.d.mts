/** Types for the build step, so the contract test can import it.
 *
 *  The script itself stays plain ESM: it runs under bare `node` during the
 *  Docker build, before any TypeScript toolchain is available in that stage.
 */
export interface PublicPage {
  /** Route path without a leading slash. */
  route: string;
  title: string;
  description: string;
}

export declare const PAGES: PublicPage[];

/** Apply one page's metadata to the built index.html. Throws rather than
 *  returning the template unchanged if a tag it must replace is missing. */
export declare function renderPageHtml(
  template: string,
  page: PublicPage,
  site?: string,
): string;
