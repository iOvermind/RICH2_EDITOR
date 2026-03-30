// src/core/parser.ts
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';
import { decompressGeneralData, compressGeneralData } from '../utils/compression';

export interface PakParsedResult {
    pakGroupPointers: number[];
    mapTilesData: Uint8Array;
    mapGrid: Uint16Array | null;
    pakTextLines: string[];
    SPECIAL_NAMES: string[];
    SEGMENT_NAMES: string[];
}

export function parseMapPakCore(dataView: DataView, rawPakBuffer: ArrayBuffer, logMsg: (msg: string) => void): PakParsedResult | null {
    logMsg("幹，來真的了，開始解包 PART?.PAK...");
    if (dataView.getUint8(0) !== 0xFD) {
        logMsg("靠背，檔頭不是 FDh，你確定這是 PAK 檔？");
        return null;
    }

    const pakSize = dataView.getUint16(5, true);
    logMsg(`封裝資料區塊總大小: ${pakSize} bytes`);

    const PAK_DATA_BASE = 7;
    let ptrOffset = PAK_DATA_BASE;
    const groupPointers: number[] = [];
    let firstDataOffset = dataView.byteLength;
    let lastValidOffset = 0;

    while (ptrOffset < firstDataOffset && ptrOffset < dataView.byteLength) {
        const ptr = dataView.getUint16(ptrOffset, true);
        if (ptr === 0) break;

        const actualOffset = PAK_DATA_BASE + ptr * 2;
        if (actualOffset >= dataView.byteLength || actualOffset <= lastValidOffset) break;

        groupPointers.push(actualOffset);
        lastValidOffset = actualOffset;

        if (actualOffset < firstDataOffset) firstDataOffset = actualOffset;
        ptrOffset += 2;
    }

    logMsg(`解析到 ${groupPointers.length} 組資料指標。`);

    if (groupPointers.length < 2) {
        logMsg("雞歪，資料組數不對，至少要有地圖方塊跟座標資料！");
        return null;
    }

    logMsg("正在解壓第 1 組：地圖方塊圖像...");
    const mapTilesData = decompressGeneralData(dataView, groupPointers[0]);
    logMsg(`解壓完成，共 ${Math.floor(mapTilesData.length / 480)} 個地圖方塊。`);

    logMsg("正在解壓第 2 組：地圖座標陣列...");
    const gridData = decompressGeneralData(dataView, groupPointers[1]);
    let mapGrid: Uint16Array | null = null;
    if (gridData.length >= 2592) {
        mapGrid = new Uint16Array(1296);
        const gridDataView = new DataView(gridData.buffer, gridData.byteOffset, gridData.byteLength);
        for (let i = 0; i < 1296; i++) {
            mapGrid[i] = gridDataView.getUint16(i * 2, true);
        }
        logMsg("地圖邏輯座標載入成功！");
    } else {
        logMsg("靠背，地圖座標解壓出來的大小不對！");
    }

    let pakTextLines: string[] = [];
    let SPECIAL_NAMES: string[] = [];
    let SEGMENT_NAMES: string[] = [""];

    if (groupPointers.length >= 3 && rawPakBuffer) {
        logMsg("正在解壓第 3 組：文字訊息...");
        const pakDV = new DataView(rawPakBuffer);
        const msgData = decompressGeneralData(pakDV, groupPointers[2]);

        if (msgData.length > 0) {
            const text = iconv.decode(Buffer.from(msgData), 'big5');
            pakTextLines = text.split(/\r\n|\r|\n/);

            for (let i = 0; i < 11; i++) {
                const name = pakTextLines[15 + i];
                SPECIAL_NAMES.push(name ? name.trim() : `特殊${i}`);
            }

            for (let i = 0; i < 99; i++) {
                const segName = pakTextLines[25 + i + 1];
                if (segName && segName.trim() !== "") {
                    SEGMENT_NAMES.push(segName.trim());
                } else {
                    break;
                }
            }
            logMsg(`文字訊息動態載入成功！目前共有 ${SEGMENT_NAMES.length - 1} 個地段。`);
        }
    }

    return { pakGroupPointers: groupPointers, mapTilesData, mapGrid, pakTextLines, SPECIAL_NAMES, SEGMENT_NAMES };
}

export function replaceGroupInDsk(dskBytes: Uint8Array, groupPointers: number[], groupIndex: number, newData: Uint8Array) {
    const DSK_DATA_BASE = 7;
    const newCompressed = compressGeneralData(newData);
    const groupStart = groupPointers[groupIndex];
    const groupEnd = (groupIndex + 1 < groupPointers.length) ? groupPointers[groupIndex + 1] : dskBytes.length;
    const delta = newCompressed.length - (groupEnd - groupStart);

    const newTotal = dskBytes.length + delta;
    const newBuf = new Uint8Array(newTotal);
    newBuf.set(dskBytes.slice(0, groupStart), 0);
    newBuf.set(newCompressed, groupStart);
    newBuf.set(dskBytes.slice(groupEnd), groupStart + newCompressed.length);

    const dv = new DataView(newBuf.buffer);
    dv.setUint16(5, newTotal - 7, true);

    const updatedPtrs = groupPointers.slice();
    for (let i = groupIndex + 1; i < updatedPtrs.length; i++) {
        updatedPtrs[i] += delta;
        const ptrVal = (updatedPtrs[i] - DSK_DATA_BASE) / 2;
        dv.setUint16(DSK_DATA_BASE + i * 2, ptrVal, true);
    }
    return { bytes: newBuf, ptrs: updatedPtrs };
}

// src/core/parser.ts 的下方新增：

export interface DskParsedResult {
    dskGroupPointers: number[];
    mapLayout: Uint16Array | null;
    locData: Uint8Array | null;
    priceData: Uint8Array | null;
}

/**
 * 解析 SAVE_?.DSK 核心邏輯
 */
export function parseSaveDskCore(dataView: DataView, logMsg: (msg: string) => void): DskParsedResult | null {
    logMsg("開始解包 SAVE_?.DSK...");
    if (dataView.getUint8(0) !== 0xFD) {
        logMsg("靠背，檔頭不是 FDh，這不是正確的封裝檔案！");
        return null;
    }

    const DSK_DATA_BASE = 7;
    let ptrOffset = DSK_DATA_BASE;
    const groupPointers: number[] = [];
    let firstDataOffset = dataView.byteLength;
    let lastValidOffset = 0;

    while (ptrOffset < firstDataOffset && ptrOffset < dataView.byteLength) {
        const ptr = dataView.getUint16(ptrOffset, true);
        if (ptr === 0) break;

        const actualOffset = DSK_DATA_BASE + ptr * 2;
        if (actualOffset >= dataView.byteLength || actualOffset <= lastValidOffset) {
            break;
        }

        groupPointers.push(actualOffset);
        lastValidOffset = actualOffset;

        if (actualOffset < firstDataOffset) {
            firstDataOffset = actualOffset;
        }
        ptrOffset += 2;
    }

    if (groupPointers.length < 6) {
        logMsg(`雞歪，存檔資料組數不到 6 組，找不到第 (6) 組的地圖排版資料！`);
        return null;
    }

    logMsg("正在解壓第 6 組：地圖排版陣列...");
    const layoutData = decompressGeneralData(dataView, groupPointers[5]);
    let mapLayout: Uint16Array | null = null;

    if (layoutData.length >= 2592) {
        mapLayout = new Uint16Array(1296);
        const layoutDataView = new DataView(layoutData.buffer, layoutData.byteOffset, layoutData.byteLength);
        for (let i = 0; i < 1296; i++) {
            mapLayout[i] = layoutDataView.getUint16(i * 2, true);
        }
        logMsg("存檔地圖排版載入成功！");
    } else {
        logMsg(`靠背，地圖排版解壓出來的大小不夠 2592 bytes！`);
        return null;
    }

    let locData: Uint8Array | null = null;
    if (groupPointers.length >= 4) {
        // LOC_COUNT 這裡固定寫 283，避免循環依賴
        const locRaw = decompressGeneralData(dataView, groupPointers[3]);
        if (locRaw.length === 283 * 20 * 2) {
            locData = locRaw;
            logMsg("地點資訊載入成功！");
        } else {
            logMsg(`地點資訊大小有異，已忽略。`);
        }
    }

    let priceData: Uint8Array | null = null;
    if (groupPointers.length >= 8) {
        const priceRaw = decompressGeneralData(dataView, groupPointers[7]);
        if (priceRaw.length > 0) {
            priceData = priceRaw;
            logMsg(`價格表載入成功！(${priceRaw.length} bytes)`);
        }
    }

    return { dskGroupPointers: groupPointers, mapLayout, locData, priceData };
}

/**
 * 重建 DSK 存檔核心邏輯
 */
export function rebuildDskBufferCore(
    rawDskBuffer: ArrayBuffer,
    dskGroupPointers: number[],
    mapLayout: Uint16Array,
    locData: Uint8Array | null,
    priceData: Uint8Array | null,
    logMsg: (msg: string) => void
): ArrayBuffer | null {

    if (!rawDskBuffer || dskGroupPointers.length < 6) {
        logMsg("靠北，DSK 還沒載入！");
        return null;
    }

    let curBytes = new Uint8Array(rawDskBuffer);
    let curPtrs = dskGroupPointers.slice();

    if (locData) {
        const r = replaceGroupInDsk(curBytes, curPtrs, 3, locData);
        curBytes = r.bytes; curPtrs = r.ptrs;
        logMsg("地點資訊已重新壓縮。");
    }

    if (priceData) {
        const dv_check = new DataView(priceData.buffer, priceData.byteOffset, priceData.byteLength);
        console.log('匯出前 seg19 各欄位:',
            Array.from({ length: 8 }, (_, fi) => dv_check.getUint16(fi * 90 + 19 * 2, true))
        );
        const r = replaceGroupInDsk(curBytes, curPtrs, 7, priceData);
        curBytes = r.bytes; curPtrs = r.ptrs;

        const verify = decompressGeneralData(new DataView(r.bytes.buffer), r.ptrs[7]);
        const dv_verify = new DataView(verify.buffer, verify.byteOffset, verify.byteLength);
        console.log('壓縮後解壓驗證 seg19:',
            Array.from({ length: 8 }, (_, fi) => dv_verify.getUint16(fi * 90 + 19 * 2, true))
        );

        logMsg("價格表已重新壓縮。");
    }

    const layoutBytes = new Uint8Array(1296 * 2);
    const ldv = new DataView(layoutBytes.buffer);
    for (let i = 0; i < 1296; i++) ldv.setUint16(i * 2, mapLayout[i], true);
    const r2 = replaceGroupInDsk(curBytes, curPtrs, 5, layoutBytes);
    curBytes = r2.bytes;

    logMsg(`DSK 重建完成，新大小: ${curBytes.length} bytes (原: ${rawDskBuffer.byteLength} bytes)`);
    return curBytes.buffer;
}