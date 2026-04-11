import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./components/AgentInterface.js";
import type { Agent, AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentInterface } from "./components/AgentInterface.js";
import { ArtifactsRuntimeProvider } from "./components/sandbox/ArtifactsRuntimeProvider.js";
import { AttachmentsRuntimeProvider } from "./components/sandbox/AttachmentsRuntimeProvider.js";
import type { SandboxRuntimeProvider } from "./components/sandbox/SandboxRuntimeProvider.js";
import { ArtifactsPanel, ArtifactsToolRenderer } from "./tools/artifacts/index.js";
import { registerToolRenderer } from "./tools/renderer-registry.js";
import type { Attachment } from "./utils/attachment-utils.js";
import { i18n } from "./utils/i18n.js";

const BREAKPOINT = 800; // px - switch between overlay and side-by-side
const STORAGE_KEY = "pi-chat-panel-artifacts-width";
const MIN_PANEL_WIDTH = 200;
const DEFAULT_PANEL_RATIO = 0.5;

@customElement("pi-chat-panel")
export class ChatPanel extends LitElement {
	@state() public agent?: Agent;
	@state() public agentInterface?: AgentInterface;
	@state() public artifactsPanel?: ArtifactsPanel;
	@state() private hasArtifacts = false;
	@state() private artifactCount = 0;
	@state() private showArtifactsPanel = false;
	@state() private windowWidth = 0;
	@state() private artifactsPanelWidth = 0;
	@state() private isDragging = false;

	private dragCleanup: ((pointerId: number) => void) | null = null;

	private resizeHandler = () => {
		this.windowWidth = window.innerWidth;
		if (this.artifactsPanelWidth > 0) {
			this.artifactsPanelWidth = this.clampPanelWidth(this.artifactsPanelWidth);
		}
		this.requestUpdate();
	};

	createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		this.windowWidth = window.innerWidth;
		const savedWidth = this.loadPanelWidth();
		if (savedWidth !== null) {
			this.artifactsPanelWidth = savedWidth;
		}
		window.addEventListener("resize", this.resizeHandler);
		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";
		requestAnimationFrame(() => {
			this.windowWidth = window.innerWidth;
			if (this.artifactsPanelWidth > 0) {
				this.artifactsPanelWidth = this.clampPanelWidth(this.artifactsPanelWidth);
			}
			this.requestUpdate();
		});
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener("resize", this.resizeHandler);
	}

	private loadPanelWidth(): number | null {
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			return saved ? parseInt(saved, 10) : null;
		} catch {
			return null;
		}
	}

	private savePanelWidth(width: number) {
		try {
			localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
		} catch {
			// Ignore storage failures (e.g. private browsing)
		}
	}

	private clampPanelWidth(width: number): number {
		const containerWidth = this.offsetWidth || this.windowWidth;
		const maxWidth = containerWidth * 0.8;
		const minWidth = Math.min(MIN_PANEL_WIDTH, containerWidth * 0.2);
		return Math.max(minWidth, Math.min(width, maxWidth));
	}

	private getDefaultPanelWidth(): number {
		const containerWidth = this.offsetWidth || this.windowWidth;
		return Math.round(containerWidth * DEFAULT_PANEL_RATIO);
	}

	private onResizeStart = (e: PointerEvent) => {
		e.preventDefault();
		this.isDragging = true;
		const startX = e.clientX;
		const startWidth = this.artifactsPanelWidth;

		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";

		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);

		const onPointerMove = (event: PointerEvent) => {
			const delta = startX - event.clientX;
			this.artifactsPanelWidth = this.clampPanelWidth(startWidth + delta);
		};

		const stopDrag = (pointerId: number) => {
			if (this.dragCleanup) {
				this.dragCleanup(pointerId);
				this.dragCleanup = null;
			}
		};

		this.dragCleanup = (pointerId: number) => {
			this.isDragging = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			handle.releasePointerCapture(pointerId);
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerCancel);
			this.savePanelWidth(this.artifactsPanelWidth);
		};

		const onPointerUp = (event: PointerEvent) => stopDrag(event.pointerId);
		const onPointerCancel = (event: PointerEvent) => stopDrag(event.pointerId);

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerCancel);
	};

	private onResizeDoubleClick = () => {
		this.artifactsPanelWidth = this.getDefaultPanelWidth();
		this.savePanelWidth(this.artifactsPanelWidth);
	};

	async setAgent(
		agent: Agent,
		config?: {
			onApiKeyRequired?: (provider: string) => Promise<boolean>;
			onBeforeSend?: () => void | Promise<void>;
			onCostClick?: () => void;
			onModelSelect?: () => void;
			sandboxUrlProvider?: () => string;
			toolsFactory?: (
				agent: Agent,
				agentInterface: AgentInterface,
				artifactsPanel: ArtifactsPanel,
				runtimeProvidersFactory: () => SandboxRuntimeProvider[],
			) => AgentTool<any>[];
		},
	) {
		this.agent = agent;

		// Create AgentInterface
		this.agentInterface = document.createElement("agent-interface") as AgentInterface;
		this.agentInterface.session = agent;
		this.agentInterface.enableAttachments = true;
		this.agentInterface.enableModelSelector = true;
		this.agentInterface.enableThinkingSelector = true;
		this.agentInterface.showThemeToggle = false;
		this.agentInterface.onApiKeyRequired = config?.onApiKeyRequired;
		this.agentInterface.onModelSelect = config?.onModelSelect;
		this.agentInterface.onBeforeSend = config?.onBeforeSend;
		this.agentInterface.onCostClick = config?.onCostClick;

		// Set up artifacts panel
		this.artifactsPanel = new ArtifactsPanel();
		this.artifactsPanel.agent = agent; // Pass agent for HTML artifact runtime providers
		if (config?.sandboxUrlProvider) {
			this.artifactsPanel.sandboxUrlProvider = config.sandboxUrlProvider;
		}
		// Register the standalone tool renderer (not the panel itself)
		registerToolRenderer("artifacts", new ArtifactsToolRenderer(this.artifactsPanel));

		// Runtime providers factory for REPL tools (read-write access)
		const runtimeProvidersFactory = () => {
			const attachments: Attachment[] = [];
			for (const message of this.agent!.state.messages) {
				if (message.role === "user-with-attachments") {
					message.attachments?.forEach((a) => {
						attachments.push(a);
					});
				}
			}
			const providers: SandboxRuntimeProvider[] = [];

			// Add attachments provider if there are attachments
			if (attachments.length > 0) {
				providers.push(new AttachmentsRuntimeProvider(attachments));
			}

			// Add artifacts provider with read-write access (for REPL)
			providers.push(new ArtifactsRuntimeProvider(this.artifactsPanel!, this.agent!, true));

			return providers;
		};

		this.artifactsPanel.onArtifactsChange = () => {
			const count = this.artifactsPanel?.artifacts?.size ?? 0;
			const created = count > this.artifactCount;
			this.hasArtifacts = count > 0;
			this.artifactCount = count;
			if (this.hasArtifacts && created) {
				this.showArtifactsPanel = true;
			}
			this.requestUpdate();
		};

		this.artifactsPanel.onClose = () => {
			this.showArtifactsPanel = false;
			this.requestUpdate();
		};

		this.artifactsPanel.onOpen = () => {
			this.showArtifactsPanel = true;
			this.requestUpdate();
		};

		// Set tools on the agent
		// Pass runtimeProvidersFactory so consumers can configure their own REPL tools
		const additionalTools =
			config?.toolsFactory?.(agent, this.agentInterface, this.artifactsPanel, runtimeProvidersFactory) || [];
		const tools = [this.artifactsPanel.tool, ...additionalTools];
		this.agent.state.tools = tools;

		// Reconstruct artifacts from existing messages
		// Temporarily disable the onArtifactsChange callback to prevent auto-opening on load
		const originalCallback = this.artifactsPanel.onArtifactsChange;
		this.artifactsPanel.onArtifactsChange = undefined;
		await this.artifactsPanel.reconstructFromMessages(this.agent.state.messages);
		this.artifactsPanel.onArtifactsChange = originalCallback;

		this.hasArtifacts = this.artifactsPanel.artifacts.size > 0;
		this.artifactCount = this.artifactsPanel.artifacts.size;

		this.requestUpdate();
	}

	render() {
		if (!this.agent || !this.agentInterface) {
			return html`<div class="flex items-center justify-center h-full">
				<div class="text-muted-foreground">No agent set</div>
			</div>`;
		}

		const isMobile = this.windowWidth < BREAKPOINT;

		// Set panel props
		if (this.artifactsPanel) {
			this.artifactsPanel.collapsed = !this.showArtifactsPanel;
			this.artifactsPanel.overlay = isMobile;
		}

		const showSplit = !isMobile && this.showArtifactsPanel && this.hasArtifacts;

		if (showSplit && this.artifactsPanelWidth === 0) {
			this.artifactsPanelWidth = this.getDefaultPanelWidth();
		}

		return html`
			<div class="relative w-full h-full overflow-hidden flex">
				<div class="h-full" style="${showSplit ? "flex: 1; min-width: 0;" : "width: 100%;"}">
					${this.agentInterface}
				</div>

				${
					this.hasArtifacts && !this.showArtifactsPanel
						? html`
							<button
								class="absolute z-30 top-4 left-1/2 -translate-x-1/2 pointer-events-auto"
								@click=${() => {
									this.showArtifactsPanel = true;
									this.requestUpdate();
								}}
								title=${i18n("Show artifacts")}
							>
								${Badge(html`
									<span class="inline-flex items-center gap-1">
										<span>${i18n("Artifacts")}</span>
										<span class="text-[10px] leading-none bg-primary-foreground/20 text-primary-foreground rounded px-1 font-mono tabular-nums">${this.artifactCount}</span>
									</span>
								`)}
							</button>
						`
						: ""
				}

				${showSplit
					? html`<div
						style="width: 6px; cursor: col-resize; flex-shrink: 0; position: relative; z-index: 10;"
						class="h-full group"
						@pointerdown=${this.onResizeStart}
						@dblclick=${this.onResizeDoubleClick}
					>
						<div
							style="position: absolute; left: 2px; top: 0; bottom: 0; width: 2px; transition: background-color 150ms;"
							class="${this.isDragging ? "bg-primary" : "bg-border group-hover:bg-primary"}"
						></div>
					</div>`
					: ""
				}

				<div class="h-full ${isMobile ? "absolute inset-0 pointer-events-none" : ""}" style="${!isMobile ? (!this.hasArtifacts || !this.showArtifactsPanel ? "display: none;" : `width: ${this.artifactsPanelWidth}px; flex-shrink: 0;`) : ""}">
					${this.artifactsPanel}
				</div>
			</div>
		`;
	}
}
