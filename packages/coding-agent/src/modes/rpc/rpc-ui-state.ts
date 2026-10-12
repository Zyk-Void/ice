import type { RpcExtensionUIRequest, RpcUIState } from "./rpc-types.ts";

/** Bounded text projection, not a terminal component renderer or another UI loop. */
export class RpcUIStateStore {
	private state: RpcUIState = { statuses: [], widgets: [], truncated: false };

	reset(): void {
		this.state = { statuses: [], widgets: [], truncated: false };
	}

	private text(value: string): string {
		if (value.length > 1024) this.state.truncated = true;
		return value.slice(0, 1024);
	}

	observe(event: RpcExtensionUIRequest): void {
		switch (event.method) {
			case "setStatus": {
				this.state.statuses = this.state.statuses.filter((status) => status.key !== this.text(event.statusKey));
				if (event.statusText !== undefined)
					this.state.statuses.push({ key: this.text(event.statusKey), text: this.text(event.statusText) });
				if (this.state.statuses.length > 64) {
					this.state.statuses.shift();
					this.state.truncated = true;
				}
				break;
			}
			case "setWidget": {
				this.state.widgets = this.state.widgets.filter((widget) => widget.key !== this.text(event.widgetKey));
				if (event.widgetLines !== undefined) {
					if (event.widgetLines.length > 32) this.state.truncated = true;
					this.state.widgets.push({
						key: this.text(event.widgetKey),
						lines: event.widgetLines.slice(0, 32).map((line) => this.text(line)),
						placement: event.widgetPlacement ?? "aboveEditor",
					});
				}
				if (this.state.widgets.length > 64) {
					this.state.widgets.shift();
					this.state.truncated = true;
				}
				break;
			}
			case "setHeader":
			case "setFooter": {
				const key = event.method === "setHeader" ? "header" : "footer";
				if (event.lines === undefined) delete this.state[key];
				else {
					if (event.lines.length > 32) this.state.truncated = true;
					this.state[key] = event.lines.slice(0, 32).map((line) => this.text(line));
				}
				break;
			}
			case "setTitle":
				this.state.title = this.text(event.title);
				break;
			case "set_editor_text":
				this.state.editorText = this.text(event.text);
				break;
			case "setWorkingMessage":
				this.state.workingMessage = event.message === undefined ? undefined : this.text(event.message);
				break;
			case "setWorkingVisible":
				this.state.workingVisible = event.visible;
				break;
			default:
				break;
		}
	}

	snapshot(): RpcUIState {
		return structuredClone(this.state);
	}
}
