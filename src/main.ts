import './style.css';
import { Workspace } from './core/workspace';
import { MapRenderer } from './render/renderer';
import { bindDOMEvents, getCanvas, logMsg } from './ui/dom-controller';

const workspace = new Workspace({ onLog: logMsg });
const canvas = getCanvas();
const ctx = canvas.getContext('2d')!;
const renderer = new MapRenderer({ ctx, workspace, onLog: logMsg });

bindDOMEvents(workspace, renderer, ctx);

renderer.redraw();
