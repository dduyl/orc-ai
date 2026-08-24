import { api } from "./api.js";
import { escapeHtml } from "./html.js";

export class WorkflowLauncher {
  private modal: HTMLDivElement | null = null;
  private workflows: any[] = [];

  async open(): Promise<void> {
    if (this.modal) return;
    await this.loadWorkflows();
    this.renderModal();
    this.bindEvents();
    this.modal!.classList.add("visible");
    (this.modal!.querySelector("#launcher-task") as HTMLTextAreaElement)?.focus();
  }

  close(): void {
    this.modal?.classList.remove("visible");
    setTimeout(() => {
      this.modal?.remove();
      this.modal = null;
    }, 200);
  }

  private getModal(): HTMLDivElement {
    if (!this.modal) throw new Error("Modal not initialized");
    return this.modal;
  }

  private async loadWorkflows(): Promise<void> {
    try {
      this.workflows = await api.listWorkflows();
    } catch {
      this.workflows = [];
    }
  }

  private renderModal(): void {
    const overlay = document.createElement("div");
    overlay.className = "workflow-launcher-overlay";
    overlay.innerHTML = `
      <div class="workflow-launcher-modal">
        <div class="launcher-header">
          <h3>New Workflow Run</h3>
          <button class="launcher-close" aria-label="Close">✕</button>
        </div>
        <div class="launcher-body">
          <div class="launcher-field">
            <label for="launcher-workflow">Workflow</label>
            <select id="launcher-workflow">
              ${this.workflows.map(w => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)} (${escapeHtml(w.id)})</option>`).join("")}
            </select>
          </div>
          <div class="launcher-field">
            <label for="launcher-task">Task</label>
            <textarea id="launcher-task" placeholder="Describe the task… (supports @mentions, Tab modes)" rows="4"></textarea>
          </div>
          <div id="launcher-params" class="launcher-field" style="display: none;">
            <label>Parameters</label>
            <div id="launcher-params-form"></div>
          </div>
        </div>
        <div class="launcher-footer">
          <button class="btn launcher-cancel">Cancel</button>
          <button class="btn btn-allow launcher-submit">Start Run</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.modal = overlay;
  }

  private bindEvents(): void {
    const modal = this.getModal();

    const closeBtn = modal.querySelector(".launcher-close");
    const cancelBtn = modal.querySelector(".launcher-cancel");
    const submitBtn = modal.querySelector(".launcher-submit");
    const workflowSelect = modal.querySelector("#launcher-workflow") as HTMLSelectElement;
    const taskInput = modal.querySelector("#launcher-task") as HTMLTextAreaElement;

    const close = () => this.close();
    closeBtn?.addEventListener("click", close);
    cancelBtn?.addEventListener("click", close);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) this.close();
    });

    workflowSelect?.addEventListener("change", () => this.renderParamsForm(workflowSelect.value));

    submitBtn?.addEventListener("click", async () => {
      const workflowId = workflowSelect?.value;
      const task = taskInput?.value?.trim();
      if (!workflowId || !task) return;

      const params = this.collectParams();
      submitBtn.setAttribute("disabled", "true");
      (submitBtn as HTMLButtonElement).textContent = "Starting…";

      try {
        await api.startWorkflow(task, workflowId, params);
        this.close();
      } catch (err) {
        submitBtn.removeAttribute("disabled");
        (submitBtn as HTMLButtonElement).textContent = "Start Run";
        alert(`Failed to start workflow: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  private renderParamsForm(workflowId: string): void {
    const paramsForm = this.getModal().querySelector("#launcher-params-form") as HTMLElement;
    const paramsContainer = this.getModal().querySelector("#launcher-params") as HTMLElement;
    if (!paramsForm || !paramsContainer || !this.workflows) return;

    const workflow = this.workflows.find(w => w.id === workflowId);
    if (!workflow?.definition?.workflow?.inputs) {
      paramsContainer.style.display = "none";
      return;
    }

    const inputs = workflow.definition.workflow.inputs;
    const fields = Object.entries(inputs).map(([rawKey, rawSchema]: [string, any]) => {
      const key = escapeHtml(rawKey);
      const schema = rawSchema ?? {};
      const type = schema.type || "string";
      let inputHtml = "";
      if (type === "boolean") {
        inputHtml = `<input type="checkbox" id="param-${key}" data-param="${key}" data-type="boolean" ${schema.default ? "checked" : ""}>`;
      } else if (schema.enum) {
        inputHtml = `<select id="param-${key}" data-param="${escapeHtml(rawKey)}" data-type="enum">${schema.enum.map((v: string) => `<option value="${escapeHtml(v)}" ${v === schema.default ? "selected" : ""}>${escapeHtml(v)}</option>`).join("")}</select>`;
      } else if (type === "number" || type === "integer") {
        inputHtml = `<input type="number" id="param-${key}" data-param="${escapeHtml(rawKey)}" data-type="${type}" value="${schema.default ?? ""}" step="${type === "integer" ? "1" : "any"}">`;
      } else {
        inputHtml = `<input type="text" id="param-${key}" data-param="${escapeHtml(rawKey)}" data-type="string" value="${schema.default ?? ""}" placeholder="${escapeHtml(schema.description ?? "")}">`;
      }
      return `<div class="param-field"><label for="param-${key}">${key}${schema.required ? " *" : ""}</label>${inputHtml}${schema.description ? `<span class="param-hint">${escapeHtml(schema.description)}</span>` : ""}</div>`;
    }).join("");

    paramsForm.innerHTML = fields;
    paramsContainer.style.display = "block";
  }

  /**
   * Collect parameter values directly from rendered `[data-param]` inputs,
   * coercing per each field's declared schema type. Never uses FormData —
   * the container is a plain div, and FormData on a non-form throws.
   */
  private collectParams(): Record<string, unknown> {
    const form = this.getModal().querySelector("#launcher-params-form");
    if (!form) return {};
    const params: Record<string, unknown> = {};
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-param]").forEach(el => {
      const key = el.dataset.param!;
      const type = el.dataset.type ?? "string";
      if (type === "boolean") {
        params[key] = (el as HTMLInputElement).checked;
        return;
      }
      const raw = el.value;
      if (type === "number" || type === "integer") {
        const n = Number(raw);
        params[key] = raw !== "" && !isNaN(n) ? n : undefined;
      } else {
        params[key] = raw;
      }
    });
    for (const key of Object.keys(params)) {
      if (params[key] === undefined) delete params[key];
    }
    return params;
  }
}