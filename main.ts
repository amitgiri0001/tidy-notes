import {
  App, Editor, EditorPosition, MarkdownView, Notice, Plugin,
  PluginSettingTab, Setting, requestUrl,
} from "obsidian";

interface TidySettings {
  apiKey: string;
  model: string;
}

const DEFAULTS: TidySettings = {
  apiKey: "",
  model: "claude-haiku-5-5",
};

const SYSTEM_PROMPT = `You turn rough, hastily typed notes into clear, well-formed sentences.

Rules:
- Fix spelling, grammar, punctuation and capitalisation. Expand shorthand only when the meaning is unambiguous.
- Do NOT add, remove or change any fact, idea, opinion, number, name or date.
- Do NOT summarise, reorder, add headings, add commentary or draw conclusions.
- Keep the structure: same bullets, nesting, headings, checkboxes and order.
- Leave untouched: [[wikilinks]], ![[embeds]], markdown links, URLs, #tags, code blocks, inline code, math, ^block-ids.
- If a fragment is too garbled to interpret confidently, keep it exactly as written.

The note arrives inside <note> tags. Output ONLY the cleaned note text, without the tags and without any preamble.`;

export default class TidyNotesPlugin extends Plugin {
  settings!: TidySettings;
  private busy = false;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("sparkles", "Tidy note", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) {
        new Notice("Open a note first.");
        return;
      }
      this.tidy(view.editor);
    });

    // Commands can be pinned to the mobile toolbar.
    this.addCommand({
      id: "tidy-selection-or-note",
      name: "Tidy selection (or whole note)",
      icon: "sparkles",
      editorCallback: (editor) => this.tidy(editor),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        menu.addItem((item) =>
          item.setTitle("Tidy text").setIcon("sparkles").onClick(() => this.tidy(editor)),
        );
      }),
    );

    this.addSettingTab(new TidySettingTab(this.app, this));
  }

  async tidy(editor: Editor) {
    if (this.busy) return;
    if (!this.settings.apiKey) {
      new Notice("Add your Anthropic API key in Tidy Notes settings.");
      return;
    }

    let from: EditorPosition;
    let to: EditorPosition;
    let text: string;

    if (editor.somethingSelected()) {
      from = editor.getCursor("from");
      to = editor.getCursor("to");
      text = editor.getSelection();
    } else {
      // Whole note, but never touch frontmatter.
      const full = editor.getValue();
      const fm = full.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
      const start = fm ? fm[0].length : 0;
      from = editor.offsetToPos(start);
      to = editor.offsetToPos(full.length);
      text = full.slice(start);
    }

    if (!text.trim()) {
      new Notice("Nothing to tidy.");
      return;
    }

    this.busy = true;
    const progress = new Notice("Tidying…", 0);
    try {
      const cleaned = await this.callClaude(text);

      // Abort if the user edited this range while we were waiting.
      if (editor.getRange(from, to) !== text) {
        new Notice("Note changed while tidying — nothing replaced. Try again.");
        return;
      }

      const lead = text.match(/^\s*/)?.[0] ?? "";
      const trail = text.match(/\s*$/)?.[0] ?? "";
      editor.replaceRange(lead + cleaned.trim() + trail, from, to);
      new Notice("Tidied. Undo restores the original.");
    } catch (e) {
      new Notice(`Tidy failed: ${(e as Error).message}`);
    } finally {
      progress.hide();
      this.busy = false;
    }
  }

  private async callClaude(text: string): Promise<string> {
    if (this.settings.apiKey.startsWith("sk-ant-oat")) {
      throw new Error("That's a Claude Code token, not an API key. Create one at console.anthropic.com.");
    }
    // requestUrl bypasses CORS and works on desktop + mobile.
    const res = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      throw: false,
      headers: {
        "x-api-key": this.settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.settings.model,
        max_tokens: 16000,
        // Clean-up needs little reasoning; thinking tokens count against max_tokens.
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `<note>\n${text}\n</note>` }],
      }),
    });

    const data = res.json;
    if (res.status >= 400) {
      throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
    }
    if (data.stop_reason === "max_tokens") {
      throw new Error("Note too long — select a smaller part.");
    }

    const out: string = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("")
      .replace(/^\s*<note>\s*/, "")
      .replace(/\s*<\/note>\s*$/, "");

    if (!out.trim()) throw new Error("Empty response.");
    return out;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class TidySettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TidyNotesPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text: "Text you tidy is sent to Anthropic's API. Your key is stored unencrypted in this plugin's data.json inside your vault.",
    });

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("From console.anthropic.com")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Haiku is fast and cheap; plenty for clean-up.")
      .addText((t) =>
        t.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v.trim() || DEFAULTS.model;
          await this.plugin.saveSettings();
        }),
      );
  }
}
