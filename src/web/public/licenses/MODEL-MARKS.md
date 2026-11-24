# Model marks

`src/web/marks/models/*.svg` are the single-colour brand marks shown next to a model name on a session card. They come, byte for byte, from the [`@lobehub/icons-static-svg`](https://www.npmjs.com/package/@lobehub/icons-static-svg) package, version 1.102.0 (MIT licence, source: [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons)). The files are not edited; only renamed to the model family they stand for:

| File | Upstream icon | Shown for model names containing |
| --- | --- | --- |
| `deepseek.svg` | `deepseek` | deepseek |
| `claude.svg` | `claude` | claude, opus, sonnet, haiku |
| `openai.svg` | `openai` | gpt, chatgpt, codex, o1 … o9 |
| `gemini.svg` | `gemini` | gemini |
| `grok.svg` | `grok` | grok |
| `kimi.svg` | `kimi` | kimi, moonshot |
| `glm.svg` | `zai` (Z.ai) | glm, chatglm, zhipu |
| `qwen.svg` | `qwen` | qwen, qwq |
| `mistral.svg` | `mistral` | mistral, mixtral, codestral, devstral, magistral |
| `llama.svg` | `meta` | llama |
| `minimax.svg` | `minimax` | minimax |
| `composer.svg` | `cursor` | composer (Cursor's own model) |

A mark is drawn only when the model name the harness reported contains one of those words (see `src/web/lib/modelFamily.ts`). Aliases such as "Auto", simulated harnesses and models from other families get no mark; no other family's mark stands in for them.

These marks identify the respective model families. They are not the Ensemble logo; the names and marks remain their owners' trademarks, and each owner's brand guidelines apply to the mark.

## Brand colours (since 2026-11-15)

The marks above stay byte-for-byte unchanged; the colour is applied separately, as a CSS mask fill in `src/web/marks/brand.css`. Colour values are facts about each brand's published assets and are used only to identify the family — never as a status or interactive colour. Sources and treatment per family:

- **Official mark colour** (the official mark is rendered in exactly this colour): `claude` `#D97757` (Anthropic brand guidelines, [anthropics/skills](https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md)); `deepseek` `#4D6BFE` (DeepSeek's official ink, [deepseek-ai](https://github.com/deepseek-ai/deepseek-harness), [Wikidata](https://www.wikidata.org/wiki/Q131983933)); `qwen` `#615CED` (violet of the official Qwen logomark vector).
- **Official gradient, interface rendering** (shape is the official mark, gradient values are official, but the gradient is re-created in CSS rather than taken from an official colour file): `gemini` `#4285F4 → #9B72CB → #D96570` (official spark gradient of the 2023–2025 mark — the shape shipped here; Google moved to a rounded four-colour spark in mid-2025); `llama` `#0081FB → #0064E0` ([Meta](https://www.meta.com/brand/resources/meta/company-brand/)); `mistral` `#FFD700 / #FFAF00 / #FF8205 / #FA500F / #E10500` ([mistral.ai/brand](https://mistral.ai/brand/) — official five flat bands, approximated by a vertical gradient at mark scale); `minimax` `#E2167F → #FF623A` (official waveform-mark gradient, cross-checked from two vector conversions of the [MiniMax Brand Book](https://www.minimax.io/brand-vi)).
- **Verified interface colour — exception, not an official colour mark**: `glm` uses `#1F63EC`, the brand blue verified from Z.ai's own site assets ([Brandfetch capture](https://brandfetch.com/z.ai), independently cross-checked). The official Z.ai logomark is a dark monochrome Z (official vector fill `#2D2D2D`); this blue is an interface colour and is **not** claimed to be an official colour logo.
- **Neutral ink — exception, official marks are black-and-white**: `openai` ([brand guidelines](https://openai.com/brand/)), `grok` ([xAI brand guidelines](https://x.ai/legal/brand-guidelines) — monochrome assets only, unaltered), `kimi` ([Moonshot brand assets](https://moonshotai.github.io/Branding-Guide/) — monochrome; their brand book mentions a signature blue but publishes no hex value), `composer` ([Cursor brand kit](https://cursor.com/brand)). These families keep the neutral ink of `styles/scene.css`; no colour is invented for them.

The Git card head icon takes two things from the official Git logo. Its colour is `#F03C2E`, the fill of the official orange Git logo file [`Git-Logo-1788C.svg`](https://git-scm.com/images/logos/downloads/Git-Logo-1788C.svg) on [git-scm.com](https://git-scm.com/community/logos) (Pantone 1788 C); only the colour value is used. Its composition — a diamond with a three-node fork inside — is the idea of the Git logo, redrawn by hand as a small solid interface icon (own geometry on a 24 grid; no file, path data or trace of the official logo is shipped). The Git logo is by Jason Long and licensed under [CC BY 3.0 Unported](https://creativecommons.org/licenses/by/3.0/); attribution: *Git Logo by Jason Long, licensed under CC BY 3.0; changes: redrawn and simplified as a small interface icon.* The Git project does not endorse Ensemble.
