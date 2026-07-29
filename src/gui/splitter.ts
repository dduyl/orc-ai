export function initSplitter(
  splitter: HTMLElement,
  termContainer: HTMLElement,
  rightPanel: HTMLElement,
  onResize: () => void,
): void {
  let dragging = false;

  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const splitX = e.clientX;
    const minLeft = 300;
    const maxRight = 200;
    const totalWidth = window.innerWidth;
    const leftWidth = Math.max(minLeft, Math.min(totalWidth - maxRight, splitX));
    termContainer.style.width = `${leftWidth - 2}px`;
    rightPanel.style.width = `${totalWidth - leftWidth - 2}px`;
    onResize();
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
  });
}
