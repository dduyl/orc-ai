import { escapeHtml } from "./html.js";

export class ActiveStep {
  private container: HTMLElement | null = null;

  mount(container: HTMLElement): void {
    this.container = container;
    container.innerHTML = `
      <div class="section-title">Active Step</div>
      <div class="active-step-content">
        <div class="active-step-empty">No active step</div>
      </div>
    `;
  }

  unmount(): void {
    this.container = null;
  }

  render(data: { stepId: string; agent: string; context: string[]; emits: string[]; waitingOn?: string }): void {
    if (!this.container) return;

    const content = this.container.querySelector(".active-step-content") as HTMLElement;
    if (!content) return;

    if (!data.stepId) {
      content.innerHTML = '<div class="active-step-empty" aria-live="polite">No active step</div>';
      return;
    }

    const contextStr = data.context.length ? data.context.map(c => escapeHtml(c)).join(", ") : "\u2014";
    const emitsStr = data.emits.length ? data.emits.map(e => escapeHtml(e)).join(", ") : "\u2014";
    const waitingOnHtml = data.waitingOn
      ? `<div class="info-row waiting"><span class="label">Waiting on</span><span class="value" aria-live="polite">${escapeHtml(data.waitingOn)}</span></div>`
      : "";

    content.innerHTML = `
      <div class="info-row"><span class="label">Step</span><span class="value">${escapeHtml(data.stepId)}</span></div>
      <div class="info-row"><span class="label">Agent</span><span class="value">${escapeHtml(data.agent)}</span></div>
      <div class="info-row"><span class="label">Context</span><span class="value">${contextStr}</span></div>
      <div class="info-row"><span class="label">Emits</span><span class="value">${emitsStr}</span></div>
      ${waitingOnHtml}
    `;
  }
}
