import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";
// 引入顺序就是层叠顺序：拆分出来的文件必须紧跟在各自的主文件之后，不能调换（settings-checkbox.css 例外，见它那一行）；这份顺序由 dock-space.test.ts 守着。
import "./styles/components.css";
import "./styles/controls.css";
import "./styles/content.css";
import "./styles/dock.css";
import "./styles/workspace.css";
import "./styles/quick-switcher.css";
import "./styles/scene.css";
import "./styles/focus.css";
import "./styles/timeline.css";
import "./styles/intervention.css";
import "./styles/question.css";
import "./styles/sidebar.css";
// 模型勾选（model-pick.css）与留存开关（archive.css）共用的框与状态：夹在 sidebar.css 与 model-pick.css 之间，先于用到它的两个文件，二者在它之上补各自独有的部分。
import "./styles/settings-checkbox.css";
import "./styles/model-pick.css";
import "./styles/overlays.css";
import "./styles/limits.css";
import "./styles/profiles.css";
import "./styles/archive.css";
import "./styles/handoff.css";
import "./styles/editorial.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");
createRoot(container).render(<App />);
