import "./components/PiWebUiApp";
import { startMathJax } from "./formatting/mathRenderer";

// Math loads after the app shell starts; settled math messages render once ready.
void startMathJax();
