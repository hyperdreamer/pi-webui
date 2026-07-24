const APP_TITLE = "PI WEBUI";

export function computeWindowTitle(projectName: string | undefined): string {
  if (projectName !== undefined && projectName !== "") return `${projectName} - ${APP_TITLE}`;
  return APP_TITLE;
}

/**
 * Sets `document.title` to `title` and observes `<head>` for external
 * mutations (including agent tool title changes), reverting them back
 * to `title`. Returns a cleanup function that disconnects the observer.
 */
export function createWindowTitleObserver(title: string): () => void {
  const sync = () => {
    if (document.title !== title) document.title = title;
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => { observer.disconnect(); };
}
