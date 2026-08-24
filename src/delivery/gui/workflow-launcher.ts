import { api } from "./renderer.js";
import { SignalTrace } from "./signal-trace.js";

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
              ${this.workflows.map(w => `<option value="${w.id}">${w.name} (${w.id})</option>`).join("")}
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
    const fields = Object.entries(inputs).map(([key, schema]: [string, any]) => {
      const type = schema.type || "string";
      let inputHtml = "";
      if (type === "boolean") {
        inputHtml = `<input type="checkbox" id="param-${key}" name="${key}" ${schema.default ? "checked" : ""}>`;
      } else if (schema.enum) {
        inputHtml = `<select id="param-${key}" name="${key}">${schema.enum.map((v: string) => `<option value="${v}" ${v === schema.default ? "selected" : ""}>${v}</option>`).join("")}</select>`;
      } else if (type === "number" || type === "integer") {
        inputHtml = `<input type="number" id="param-${key}" name="${key}" value="${schema.default ?? ""}" step="${type === "integer" ? "1" : "any"}">`;
      } else {
        inputHtml = `<input type="text" id="param-${key}" name="${key}" value="${schema.default ?? ""}" placeholder="${schema.description ?? ""}">`;
      }
      return `<div class="param-field"><label for="param-${key}">${key}${schema.required ? " *" : ""}</label>${inputHtml}${schema.description ? `<span class="param-hint">${schema.description}</span>` : ""}</div>`;
    }).join("");

    paramsForm.innerHTML = fields;
    paramsContainer.style.display = "block";
  }

  private collectParams(): Record<string, unknown> {
    const form = this.getModal().querySelector("#launcher-params-form") as HTMLFormElement;
    if (!form) return {};
    const data = new FormData(form);
    const params: Record<string, unknown> = {};
    data.forEach((value: FormDataEntryValue, key: string) => {
      if (value === "on") params[key] = true;
      else if (value === "off") params[key] = false;
      else if (!isNaN(Number(value)) && value !== "") params[key] = Number(value);
      else params[key] = value;
    });
    return params;
  }
}