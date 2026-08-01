import { parseMapPakCore, parseSaveDskCore } from './parser';
import { decompressGeneralData } from '../utils/compression';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';

export interface WorkspaceConfig {
    onLog?: (msg: string) => void;
}

export class Workspace {
    private onLog: (msg: string) => void;

    // 生資料
    public rawPakBuffer: ArrayBuffer | null = null;
    public rawDskBuffer: ArrayBuffer | null = null;
    
    // 指標
    public pakGroupPointers: number[] = [];
    public dskGroupPointers: number[] = [];
    
    // 解析後的地圖資料
    public mapTilesData: Uint8Array = new Uint8Array(0);
    public mapGrid: Uint16Array = new Uint16Array(1296);
    public mapLayout: Uint16Array = new Uint16Array(1296);
    
    public priceData: Uint8Array | null = null;
    public locData: Uint8Array | null = null;
    /** 角色參數（DSK 第 1 組）：現金／存款／AI 門檻 */
    public playerData: Uint8Array | null = null;
    
    // 文字資料
    public pakTextLines: string[] = [];
    public specialNames: string[] = ["土地/公園"];
    public segmentNames: string[] = [""];
    
    // 狀態旗標
    public isPaletteLoaded: boolean = true; // 預設為 true (如原 main.ts)
    public isSaveLoaded: boolean = false;

    constructor(config: WorkspaceConfig = {}) {
        this.onLog = config.onLog || (() => {});
    }

    public log(msg: string): void {
        this.onLog(msg);
    }

    public loadPak(buffer: ArrayBuffer): boolean {
        this.rawPakBuffer = buffer.slice(0);
        const dataView = new DataView(buffer);
        const result = parseMapPakCore(dataView, buffer, this.log.bind(this));
        
        if (!result) return false;

        this.pakGroupPointers = result.pakGroupPointers;
        this.mapTilesData = result.mapTilesData;
        if (result.mapGrid) {
            this.mapGrid.set(result.mapGrid);
        }
        
        this.pakTextLines = result.pakTextLines;
        this.specialNames = result.SPECIAL_NAMES;
        this.segmentNames = result.SEGMENT_NAMES;

        return true;
    }

    public loadDsk(buffer: ArrayBuffer): boolean {
        this.rawDskBuffer = buffer.slice(0);
        const dataView = new DataView(buffer);
        const result = parseSaveDskCore(dataView, this.log.bind(this));
        
        if (!result) return false;

        this.dskGroupPointers = result.dskGroupPointers;

        if (result.mapLayout) {
            this.mapLayout.set(result.mapLayout);
            this.isSaveLoaded = true;
        }

        if (result.locData) {
            this.locData = result.locData;
        }

        if (result.playerData) {
            this.playerData = result.playerData;
        }

        if (result.priceData) {
            this.priceData = result.priceData;
        }

        // 重新載入文字訊息 (如果 PAK 先載入過的話)
        if (this.rawPakBuffer && this.pakGroupPointers.length >= 3) {
            this.reloadPakTextMessages();
        }

        return true;
    }

    private reloadPakTextMessages(): void {
        if (!this.rawPakBuffer) return;
        
        this.log("正在重新讀取 PAK 的文字訊息...");
        const pakDV = new DataView(this.rawPakBuffer);
        const msgData = decompressGeneralData(pakDV, this.pakGroupPointers[2]);

        if (msgData.length > 0) {
            const text = iconv.decode(Buffer.from(msgData), 'big5');
            this.pakTextLines = text.split('\r');

            this.specialNames = [];
            for (let i = 0; i < 11; i++) {
                const name = this.pakTextLines[15 + i];
                this.specialNames.push(name ? name.trim() : `特殊${i}`);
            }

            this.segmentNames = [""];
            for (let i = 0; i < 99; i++) {
                const segName = this.pakTextLines[26 + i];
                if (segName && segName.trim() !== "") {
                    this.segmentNames.push(segName.trim());
                } else {
                    break;
                }
            }
            this.log(`文字訊息更新成功！共 ${this.segmentNames.length - 1} 個地段。`);
        }
    }
}
