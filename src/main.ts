import './style.css';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';

// 新增一個全域變數，用來記住 PAK 解壓出來的完整文字內容
let pakTextLines: string[] = [];

// DOM 元素綁定與型別轉換
const canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const infoBox = document.getElementById('infoBox') as HTMLDivElement;

// 遊戲常數定義
const GRID_COLS: number = 36; // 36x36 網格
const GRID_ROWS: number = 36;
const TILE_W: number = 24;    // 每個區塊 24x20
const TILE_H: number = 20;

// 256色色盤，從 256.PAT 硬編碼 (RGB 0~255)
const palette: Uint8Array = new Uint8Array([
  0, 0, 0, 12, 12, 12, 28, 28, 28, 45, 45, 45, 61, 61, 61, 77, 77, 77, 93, 93, 93, 109, 109, 109,
  125, 125, 125, 142, 142, 142, 162, 162, 162, 178, 178, 178, 198, 198, 198, 215, 215, 215, 235, 235, 235, 255, 255, 255,
  61, 0, 0, 77, 0, 0, 97, 0, 0, 117, 0, 0, 138, 0, 0, 158, 0, 0, 174, 0, 0, 194, 0, 0,
  215, 0, 0, 235, 0, 0, 255, 0, 0, 255, 36, 36, 255, 77, 77, 255, 117, 117, 255, 158, 158, 255, 202, 202,
  77, 49, 0, 97, 61, 0, 121, 73, 4, 142, 85, 12, 166, 97, 20, 186, 113, 28, 210, 125, 40, 231, 138, 57,
  255, 154, 73, 255, 170, 97, 255, 186, 125, 255, 202, 150, 255, 219, 178, 255, 223, 190, 255, 231, 202, 255, 239, 219,
  93, 93, 0, 105, 105, 0, 117, 117, 0, 134, 134, 0, 146, 146, 0, 158, 158, 0, 174, 174, 0, 186, 186, 0,
  198, 198, 0, 215, 215, 0, 227, 227, 0, 239, 239, 0, 255, 255, 0, 255, 255, 69, 255, 255, 142, 255, 255, 219,
  0, 49, 0, 0, 61, 0, 0, 77, 0, 0, 93, 0, 0, 109, 0, 0, 125, 0, 0, 138, 0, 0, 154, 0,
  0, 170, 0, 0, 186, 0, 0, 202, 0, 28, 210, 28, 69, 223, 69, 109, 231, 109, 154, 243, 154, 202, 255, 202,
  0, 0, 61, 0, 0, 77, 0, 0, 97, 0, 0, 117, 0, 0, 138, 0, 0, 158, 0, 0, 174, 0, 0, 194,
  0, 0, 215, 0, 0, 235, 0, 0, 255, 36, 36, 255, 77, 77, 255, 117, 117, 255, 158, 158, 255, 202, 202, 255,
  73, 0, 121, 81, 4, 130, 89, 12, 138, 97, 20, 146, 109, 32, 154, 121, 45, 166, 130, 57, 174, 142, 69, 182,
  154, 85, 190, 166, 101, 198, 178, 117, 210, 190, 134, 219, 202, 154, 227, 215, 174, 235, 227, 194, 243, 243, 219, 255,
  77, 0, 77, 97, 0, 97, 121, 0, 121, 142, 0, 142, 166, 0, 166, 186, 0, 186, 210, 0, 210, 231, 0, 231,
  255, 0, 255, 255, 24, 255, 255, 57, 255, 255, 89, 255, 255, 121, 255, 255, 154, 255, 255, 186, 255, 255, 219, 255,
  0, 89, 89, 0, 105, 105, 0, 121, 121, 0, 138, 138, 0, 154, 154, 0, 170, 170, 0, 186, 186, 0, 202, 202,
  0, 219, 219, 0, 239, 239, 0, 255, 255, 40, 255, 255, 85, 255, 255, 130, 255, 255, 174, 255, 255, 219, 255, 255,
  101, 77, 49, 138, 97, 57, 174, 113, 69, 210, 125, 73, 215, 134, 81, 215, 142, 93, 219, 150, 105, 223, 158, 117,
  227, 166, 130, 231, 174, 142, 235, 186, 154, 239, 194, 166, 243, 202, 178, 247, 215, 194, 251, 223, 206, 255, 235, 223,
  97, 32, 0, 105, 40, 0, 117, 49, 4, 125, 61, 12, 138, 69, 20, 150, 81, 32, 158, 93, 40, 170, 105, 53,
  178, 117, 65, 190, 134, 77, 202, 146, 93, 210, 162, 105, 223, 174, 121, 231, 190, 138, 243, 206, 158, 255, 223, 178,
  97, 69, 0, 121, 77, 0, 150, 81, 0, 178, 81, 0, 182, 93, 8, 190, 109, 24, 194, 125, 40, 202, 142, 57,
  210, 158, 77, 215, 170, 97, 223, 186, 117, 227, 198, 138, 235, 215, 162, 239, 227, 182, 247, 239, 206, 255, 251, 235,
  32, 73, 182, 40, 81, 186, 49, 93, 190, 61, 105, 198, 69, 113, 202, 81, 125, 210, 89, 138, 215, 101, 150, 219,
  113, 162, 227, 125, 174, 231, 138, 182, 235, 150, 194, 243, 162, 206, 247, 178, 219, 255, 190, 227, 255, 202, 235, 255,
  0, 61, 0, 0, 73, 0, 4, 85, 0, 4, 97, 0, 8, 109, 0, 16, 121, 0, 20, 134, 0, 28, 146, 0,
  36, 158, 0, 45, 174, 0, 57, 186, 0, 69, 198, 0, 81, 215, 0, 93, 227, 0, 109, 239, 0, 125, 255, 0,
  0, 0, 81, 0, 0, 93, 4, 4, 109, 12, 12, 125, 20, 20, 142, 28, 28, 154, 40, 40, 170, 53, 53, 186,
  69, 69, 202, 85, 85, 206, 101, 101, 215, 117, 117, 223, 138, 138, 231, 158, 158, 239, 178, 178, 247, 202, 202, 255,
  0, 0, 162, 0, 16, 182, 0, 40, 206, 0, 69, 231, 0, 105, 255, 0, 77, 235, 0, 57, 227, 0, 32, 219,
  0, 12, 210, 0, 0, 202, 255, 223, 0, 255, 255, 0, 255, 255, 182, 255, 235, 0, 255, 202, 0, 49, 178, 255
]);

// TS 介面定義
interface WarningMsg {
  type: string;
  cells: number[];
  msg: string;
}

let isPaletteLoaded: boolean = true;
let mapTilesData: Uint8Array = new Uint8Array(0);
let mapGrid: Uint16Array = new Uint16Array(GRID_COLS * GRID_ROWS);
let mapLayout: Uint16Array = new Uint16Array(GRID_COLS * GRID_ROWS);
let isSaveLoaded: boolean = false;
let rawPakBuffer: ArrayBuffer | null = null;
let rawDskBuffer: ArrayBuffer | null = null;
let pakGroupPointers: number[] = [];
let dskGroupPointers: number[] = [];

// 路段名稱
let SEGMENT_NAMES: string[] = [""];
let SPECIAL_NAMES: string[] = ["土地/公園"];

// 價格表欄位定義
const PRICE_FIELD_COUNT: number = 10;
const PRICE_SEG_COUNT: number = 45;
const PRICE_FIELD_SIZE: number = PRICE_SEG_COUNT * 2;
const PRICE_FIELDS: string[] = ['土地價格', '增值價格', '空地過路費', '一層過路費', '二層過路費', '三層過路費', '四層過路費', '五層過路費', '欄位8', '欄位9'];
let priceData: Uint8Array | null = null;
let priceDataView: DataView | null = null;

// 地點資訊
const LOC_COUNT: number = 283;
const LOC_FIELDS = {
  X: 0x0000, Y: 0x0236, SPECIAL: 0x046C,
  UNK3: 0x06A2, LEFT: 0x08D8, UP: 0x0B0E,
  RIGHT: 0x0D44, DOWN: 0x0F7A, SEGMENT: 0x11B0,
  UNK9: 0x13E6, UNKA: 0x161C, UNKB: 0x1852,
  OWNER: 0x1A88, UNKD: 0x1CBE, RESERVE: 0x1EF4,
  HOUSE: 0x212A, UNK10: 0x2360, UNK11: 0x2596,
  UNK12: 0x27CC, UNK13: 0x2A02
};
let locData: Uint8Array | null = null;
let locDataView: DataView | null = null;

let selectedGridX: number = -1, selectedGridY: number = -1;
let selectedTileIndex: number = -1;

function drawGrid(): void {
  ctx.strokeStyle = '#333';
  for (let x = 0; x <= canvas.width; x += TILE_W) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y <= canvas.height; y += TILE_H) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
}
drawGrid();

function logMsg(msg: string): void {
  infoBox.innerHTML += `<br>> ${msg}`;
  infoBox.scrollTop = infoBox.scrollHeight;
}

// 真實的一般資料解壓法 (加上嚴格邊界保護)
function decompressGeneralData(dataView: DataView, startOffset: number): Uint8Array {
  // 防呆：如果起始位置就已經超過檔案大小，直接回傳空陣列
  if (startOffset < 0 || startOffset + 2 > dataView.byteLength) {
    console.error(`[解壓錯誤] 嘗試從無效的偏移量讀取: ${startOffset}`);
    return new Uint8Array(0);
  }

  const output: number[] = [];
  const no = dataView.getUint16(startOffset, true);
  let currentPtr = startOffset + 2;

  for (let i = 0; i < no; i++) {
    if (currentPtr >= dataView.byteLength) break;

    const b = dataView.getUint8(currentPtr++);
    const c = (b & 0x7F) + 1;
    const isHighBitSet = (b & 0x80) !== 0;

    if (isHighBitSet) {
      for (let j = 0; j < c; j++) {
        if (currentPtr >= dataView.byteLength) break; // 雙重防呆
        output.push(dataView.getUint8(currentPtr++));
      }
    } else {
      if (currentPtr >= dataView.byteLength) break;   // 雙重防呆
      const repeatByte = dataView.getUint8(currentPtr++);
      for (let j = 0; j < c; j++) {
        output.push(repeatByte);
      }
    }
  }
  return new Uint8Array(output);
}

// 實作真正的 RLE 壓縮，並加入偶數對齊防崩潰機制
function compressGeneralData(inputBytes: Uint8Array): Uint8Array {
  const output: number[] = [];
  let i = 0;
  let chunks = 0;

  while (i < inputBytes.length) {
    let repeatCount = 1;
    while (i + repeatCount < inputBytes.length && repeatCount < 128 && inputBytes[i + repeatCount] === inputBytes[i]) {
      repeatCount++;
    }

    if (repeatCount >= 3) {
      output.push(repeatCount - 1);
      output.push(inputBytes[i]);
      i += repeatCount;
      chunks++;
    } else {
      let rawCount = 0;
      while (i + rawCount < inputBytes.length && rawCount < 128) {
        if (i + rawCount + 2 < inputBytes.length &&
          inputBytes[i + rawCount] === inputBytes[i + rawCount + 1] &&
          inputBytes[i + rawCount] === inputBytes[i + rawCount + 2]) {
          break;
        }
        rawCount++;
      }

      output.push(0x80 | (rawCount - 1));
      for (let j = 0; j < rawCount; j++) {
        output.push(inputBytes[i + j]);
      }
      i += rawCount;
      chunks++;
    }
  }

  const isOdd = (output.length % 2 !== 0);
  const result = new Uint8Array(2 + output.length + (isOdd ? 1 : 0));
  result[0] = chunks & 0xFF;
  result[1] = (chunks >> 8) & 0xFF;
  result.set(output, 2);
  return result;
}

// 處理 PART?.PAK 封裝資料集
(document.getElementById('mapFile') as HTMLInputElement).addEventListener('change', function (e: Event) {
  const target = e.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];
  const reader = new FileReader();
  reader.onload = function (event: ProgressEvent<FileReader>) {
    if (!event.target || !event.target.result) return;
    rawPakBuffer = (event.target.result as ArrayBuffer).slice(0);
    const buffer = new DataView(event.target.result as ArrayBuffer);
    parseMapPak(buffer);
  };
  reader.readAsArrayBuffer(file);
});

function parseMapPak(dataView: DataView): void {
  logMsg("幹，來真的了，開始解包 PART?.PAK...");
  if (dataView.getUint8(0) !== 0xFD) {
    logMsg("靠背，檔頭不是 FDh，你確定這是 PAK 檔？");
    return;
  }

  const pakSize = dataView.getUint16(5, true);
  logMsg(`封裝資料區塊總大小: ${pakSize} bytes`);

  const PAK_DATA_BASE = 7;
  let ptrOffset = PAK_DATA_BASE;
  const groupPointers: number[] = [];
  let firstDataOffset = dataView.byteLength;
  let lastValidOffset = 0; // 防呆機制

  while (ptrOffset < firstDataOffset && ptrOffset < dataView.byteLength) {
    const ptr = dataView.getUint16(ptrOffset, true);
    if (ptr === 0) break;

    const actualOffset = PAK_DATA_BASE + ptr * 2;
    if (actualOffset >= dataView.byteLength || actualOffset <= lastValidOffset) break;

    groupPointers.push(actualOffset);
    lastValidOffset = actualOffset;

    if (actualOffset < firstDataOffset) {
      firstDataOffset = actualOffset;
    }
    ptrOffset += 2;
  }

  pakGroupPointers = groupPointers;
  logMsg(`解析到 ${groupPointers.length} 組資料指標。`);

  if (groupPointers.length < 2) {
    logMsg("雞歪，資料組數不對，至少要有地圖方塊跟座標資料！");
    return;
  }

  logMsg("正在解壓第 1 組：地圖方塊圖像...");
  mapTilesData = decompressGeneralData(dataView, groupPointers[0]);
  const tileCount = Math.floor(mapTilesData.length / 480);
  logMsg(`解壓完成，共 ${tileCount} 個地圖方塊。`);

  logMsg("正在解壓第 2 組：地圖座標陣列...");
  const gridData = decompressGeneralData(dataView, groupPointers[1]);
  if (gridData.length >= 2592) {
    const gridDataView = new DataView(gridData.buffer, gridData.byteOffset, gridData.byteLength);
    for (let i = 0; i < 1296; i++) {
      mapGrid[i] = gridDataView.getUint16(i * 2, true);
    }
    logMsg("地圖邏輯座標載入成功！");
  } else {
    logMsg("靠背，地圖座標解壓出來的大小不對！");
  }

  // 7. 解壓第 3 組資料：文字訊息 (這才是對的地方，拿 PAK 的 dataView 去讀)
  if (pakGroupPointers.length >= 3) {
    logMsg("正在解壓第 3 組：文字訊息...");
    if (rawPakBuffer && pakGroupPointers.length >= 3) {
      const pakDV = new DataView(rawPakBuffer);
      const msgData = decompressGeneralData(pakDV, pakGroupPointers[2]);

      if (msgData.length > 0) {
        const text = iconv.decode(Buffer.from(msgData), 'big5');

        pakTextLines = text.split(/\r\n|\r|\n/);

        SPECIAL_NAMES = [];
        for (let i = 0; i < 11; i++) {
          const name = pakTextLines[15 + i];
          SPECIAL_NAMES.push(name ? name.trim() : `特殊${i}`);
        }

        SEGMENT_NAMES = [""];
        for (let i = 0; i < 99; i++) {
          const segName = pakTextLines[25 + i + 1];
          if (segName && segName.trim() !== "") {
            SEGMENT_NAMES.push(segName.trim());
          } else {
            break;
          }
        }
        // === DEBUG：印出前 40 行文字內容，確認行號對不對 ===
        console.log("=== pakTextLines 前 40 行 ===");
        pakTextLines.slice(0, 40).forEach((line, idx) => {
          console.log(`[${idx}] "${line}"`);
        });
        console.log(`=== SEGMENT_NAMES: `, SEGMENT_NAMES);
        // === DEBUG END ===
        logMsg(`文字訊息動態載入成功！目前共有 ${SEGMENT_NAMES.length - 1} 個地段。`);
      }
    }
  }
  // 渲染地圖判定
  if (isSaveLoaded) {
    checkAndRenderRealMap();
  } else if (isPaletteLoaded) {
    logMsg("存檔還沒載入，先 Dump 圖庫給你看...");
    renderTilesetDump();
  } else {
    drawGrid();
  }
}

function renderTilesetDump(): void {
  if (!mapTilesData || mapTilesData.length === 0) return;

  logMsg("開始將圖塊圖庫 Dump 到畫布上...");
  const imgData = ctx.createImageData(canvas.width, canvas.height);
  const totalTiles = Math.floor(mapTilesData.length / 480);

  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      const tileIndex = gy * GRID_COLS + gx;
      if (tileIndex >= totalTiles) break;

      const srcOffset = tileIndex * 480;
      for (let ty = 0; ty < TILE_H; ty++) {
        for (let tx = 0; tx < TILE_W; tx++) {
          const colorIndex = mapTilesData[srcOffset + ty * TILE_W + tx];
          const pxX = gx * TILE_W + tx;
          const pxY = gy * TILE_H + ty;
          const destOffset = (pxY * canvas.width + pxX) * 4;

          imgData.data[destOffset] = palette[colorIndex * 3];
          imgData.data[destOffset + 1] = palette[colorIndex * 3 + 1];
          imgData.data[destOffset + 2] = palette[colorIndex * 3 + 2];
          imgData.data[destOffset + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
  drawGrid();
}

// 處理 SAVE_?.DSK 存檔
(document.getElementById('saveFile') as HTMLInputElement).addEventListener('change', function (e: Event) {
  const target = e.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];
  const reader = new FileReader();
  reader.onload = function (event: ProgressEvent<FileReader>) {
    if (!event.target || !event.target.result) return;
    rawDskBuffer = (event.target.result as ArrayBuffer).slice(0);
    const buffer = new DataView(event.target.result as ArrayBuffer);
    parseSaveDsk(buffer);
  };
  reader.readAsArrayBuffer(file);
});

function parseSaveDsk(dataView: DataView): void {
  logMsg("開始解包 SAVE_?.DSK...");
  if (dataView.getUint8(0) !== 0xFD) {
    logMsg("靠背，檔頭不是 FDh，這不是正確的封裝檔案！");
    return;
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

  dskGroupPointers = groupPointers;
  if (groupPointers.length < 6) {
    logMsg(`雞歪，存檔資料組數不到 6 組，找不到第 (6) 組的地圖排版資料！`);
    return;
  }

  logMsg("正在解壓第 6 組：地圖排版陣列...");
  const layoutData = decompressGeneralData(dataView, groupPointers[5]);

  if (layoutData.length >= 2592) {
    const layoutDataView = new DataView(layoutData.buffer, layoutData.byteOffset, layoutData.byteLength);
    for (let i = 0; i < 1296; i++) {
      mapLayout[i] = layoutDataView.getUint16(i * 2, true);
    }
    isSaveLoaded = true;
    (window as any)._locDataView = locDataView;  // ← 加這行

    logMsg("存檔地圖排版載入成功！");

    if (rawPakBuffer && pakGroupPointers.length >= 3) {
      logMsg("正在解壓 PAK 第 3 組：文字訊息...");
      const pakDV = new DataView(rawPakBuffer);
      const msgData = decompressGeneralData(pakDV, pakGroupPointers[2]);

      if (msgData.length > 0) {
        const text = iconv.decode(Buffer.from(msgData), 'big5');
        // === DEBUG：確認換行字元 ===
        console.log("前100字元的 charCode：", [...text.slice(0, 200)].map(c => c.charCodeAt(0).toString(16)).join(' '));
        // === DEBUG END ===
        pakTextLines = text.split(/\r\n|\r|\n/);

        SPECIAL_NAMES = [];
        for (let i = 0; i < 11; i++) {
          const name = pakTextLines[15 + i];
          SPECIAL_NAMES.push(name ? name.trim() : `特殊${i}`);
        }

        SEGMENT_NAMES = [""];
        for (let i = 0; i < 99; i++) {
          const segName = pakTextLines[26 + i]; // index 26 開始是地段 1
          if (segName && segName.trim() !== "") {
            SEGMENT_NAMES.push(segName.trim());
          } else {
            break;
          }
        }
        logMsg(`文字訊息載入成功！共 ${SEGMENT_NAMES.length - 1} 個地段。`);
      }
    }

    if (dskGroupPointers.length >= 4) {
      const locRaw = decompressGeneralData(dataView, dskGroupPointers[3]);
      if (locRaw.length === LOC_COUNT * 20 * 2) {
        locData = locRaw;
        locDataView = new DataView(locData.buffer, locData.byteOffset, locData.byteLength);
        logMsg("地點資訊載入成功！");
      } else {
        logMsg(`地點資訊大小有異，已忽略。`);
      }
    }

    if (dskGroupPointers.length >= 8) {
      const priceRaw = decompressGeneralData(dataView, dskGroupPointers[7]);
      if (priceRaw.length > 0) {
        priceData = priceRaw;
        priceDataView = new DataView(priceData.buffer, priceData.byteOffset, priceData.byteLength);
        logMsg(`價格表載入成功！(${priceRaw.length} bytes)`);
      }
    }

    setTimeout(runValidation, 100);
    checkAndRenderRealMap();
  } else {
    logMsg(`靠背，地圖排版解壓出來的大小不夠 2592 bytes！`);
  }
}

(window as any)._rawDskBuffer = rawDskBuffer;

function checkAndRenderRealMap(): void {
  if (isPaletteLoaded && mapTilesData.length > 0 && isSaveLoaded) {
    logMsg("幹，三神器湊齊了！開始渲染真正的地圖...");

    const imgData = ctx.createImageData(canvas.width, canvas.height);
    const totalTiles = Math.floor(mapTilesData.length / 480);

    for (let gy = 0; gy < GRID_ROWS; gy++) {
      for (let gx = 0; gx < GRID_COLS; gx++) {
        const cellIndex = gy * GRID_COLS + gx;
        const tileIndex = mapLayout[cellIndex];

        if (tileIndex >= totalTiles) continue;

        const srcOffset = tileIndex * 480;
        for (let ty = 0; ty < TILE_H; ty++) {
          for (let tx = 0; tx < TILE_W; tx++) {
            const colorIndex = mapTilesData[srcOffset + ty * TILE_W + tx];
            const pxX = gx * TILE_W + tx;
            const pxY = gy * TILE_H + ty;
            const destOffset = (pxY * canvas.width + pxX) * 4;

            imgData.data[destOffset] = palette[colorIndex * 3];
            imgData.data[destOffset + 1] = palette[colorIndex * 3 + 1];
            imgData.data[destOffset + 2] = palette[colorIndex * 3 + 2];
            imgData.data[destOffset + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    drawGrid();
  } else {
    logMsg("還缺檔案喔！PAT、PAK、DSK 三個都要載入才會啟動真地圖模式。");
  }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const targetBtn = e.currentTarget as HTMLElement;
    const tabId = targetBtn.dataset.tab;
    if (!tabId) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    targetBtn.classList.add('active');
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');
    if (tabId === 'tabWarn') runValidation();
  });
});

function getSegName(segId: number): string {
  if (segId <= 0) return '';
  if (segId < SEGMENT_NAMES.length) return SEGMENT_NAMES[segId];
  return extraSegNames[segId] || `地段${segId}`;
}

function calcSegmentOrder(segId: number, locId: number): number {
  if (!locDataView || segId <= 0 || locId <= 0) return 0;
  let order = 1;
  for (let i = 1; i < LOC_COUNT; i++) {
    if (i === locId) continue;
    if (getLocField(LOC_FIELDS.SEGMENT, i) === segId) order++;
  }
  return order;
}

function inferSegmentSharedField(segId: number, field: number, fallback: number): number {
  if (!locDataView || segId <= 0) return fallback;
  const counter = new Map<number, number>();
  for (let i = 1; i < LOC_COUNT; i++) {
    if (getLocField(LOC_FIELDS.SEGMENT, i) !== segId) continue;
    const v = getLocField(field, i);
    counter.set(v, (counter.get(v) || 0) + 1);
  }
  if (counter.size === 0) return fallback;
  return [...counter.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function detectMarkerDir(baseLocId: number): number {
  const marker = baseLocId + 950;
  let baseIdx = -1;
  let markerIdx = -1;
  for (let i = 0; i < mapGrid.length; i++) {
    if (mapGrid[i] === baseLocId) baseIdx = i;
    if (mapGrid[i] === marker) markerIdx = i;
  }
  if (baseIdx < 0 || markerIdx < 0) return 0;
  const bx = baseIdx % GRID_COLS, by = Math.floor(baseIdx / GRID_COLS);
  const mx = markerIdx % GRID_COLS, my = Math.floor(markerIdx / GRID_COLS);
  if (mx < bx && my === by) return 1;
  if (my < by && mx === bx) return 2;
  if (mx > bx && my === by) return 3;
  if (my > by && mx === bx) return 4;
  return 0;
}

function dirLabel(dir: number): string {
  return dir === 1 ? '左' : dir === 2 ? '上' : dir === 3 ? '右' : dir === 4 ? '下' : '無';
}

function applyFieldToSegment(segId: number, field: number, val: number): void {
  if (!locDataView || segId <= 0) return;
  for (let i = 1; i < LOC_COUNT; i++) {
    if (getLocField(LOC_FIELDS.SEGMENT, i) === segId) setLocField(field, i, val);
  }
}

function applySegmentDerivedFields(locId: number, segId: number): void {
  if (!locDataView || locId <= 0 || segId <= 0) return;
  setLocField(LOC_FIELDS.SEGMENT, locId, segId);
  setLocField(LOC_FIELDS.UNK9, locId, calcSegmentOrder(segId, locId));

  const unkaInput = document.getElementById('editUnkA') as HTMLInputElement | null;
  const unkbInput = document.getElementById('editUnkB') as HTMLInputElement | null;
  const unka = (unkaInput && unkaInput.value !== '') ? (parseInt(unkaInput.value) || 0) : inferSegmentSharedField(segId, LOC_FIELDS.UNKA, 1);
  const unkb = (unkbInput && unkbInput.value !== '') ? (parseInt(unkbInput.value) || 0) : inferSegmentSharedField(segId, LOC_FIELDS.UNKB, 1);
  setLocField(LOC_FIELDS.UNKA, locId, unka);
  setLocField(LOC_FIELDS.UNKB, locId, unkb);

  const dir = detectMarkerDir(locId);
  if (dir > 0) setLocField(LOC_FIELDS.UNK3, locId, dir);
}

function getSpecialName(spId: number): string {
  // 改成 >= 0，把 ID 0 給放行！
  return (spId >= 0 && spId < SPECIAL_NAMES.length) ? SPECIAL_NAMES[spId] : '';
}

(document.getElementById('editSpecial') as HTMLInputElement).addEventListener('input', function (e: Event) {
  if (selectedGridX < 0) return;
  const target = e.target as HTMLInputElement;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  const spId = parseInt(target.value) || 0;
  (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = getSpecialName(spId);
  if (locId > 0 && locData) setLocField(LOC_FIELDS.SPECIAL, locId, spId);
});

const extraSegNames: Record<number, string> = {};
const extraPriceData: Record<number, Record<number, number>> = {};

(document.getElementById('addSegBtn') as HTMLButtonElement).addEventListener('click', function () {
  if (!locData) { logMsg('請先載入 DSK！'); return; }

  // 掃描目前被使用的地段編號
  const usedSegs = new Set<number>();
  for (let i = 1; i < LOC_COUNT; i++) {
    const seg = getLocField(LOC_FIELDS.SEGMENT, i);
    if (seg > 0) usedSegs.add(seg);
  }

  // 找第一個空的 slot（1～44 裡沒被用到的）
  let newSegId = -1;
  for (let i = 1; i <= 44; i++) {
    if (!usedSegs.has(i)) { newSegId = i; break; }
  }

  if (newSegId === -1) { logMsg('地段已全滿（1～44 全部使用中）！'); return; }

  const name = prompt(`新地段編號 ${newSegId}，請輸入名稱：`, `地段${newSegId}`);
  if (!name) return;

  // 更新 SEGMENT_NAMES（確保陣列夠長）
  while (SEGMENT_NAMES.length <= newSegId) SEGMENT_NAMES.push('');
  SEGMENT_NAMES[newSegId] = name;

  // 更新 pakTextLines（index = 25 + newSegId）
  pakTextLines[25 + newSegId] = '             ' + name;  // 13個空白
  SEGMENT_NAMES[newSegId] = name;  // UI顯示用，不需要空白

  // 套用到目前選取的格子
  if (selectedGridX >= 0) {
    const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
    (document.getElementById('editSegId') as HTMLInputElement).value = newSegId.toString();
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = name;
    if (locId > 0 && locData) {
      applySegmentDerivedFields(locId, newSegId);
      (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, locId).toString();
      (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, locId).toString();
      (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, locId).toString();
      (document.getElementById('editUnk3') as HTMLSelectElement).value = getLocField(LOC_FIELDS.UNK3, locId).toString();
      const suggest = detectMarkerDir(locId);
      (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;
      renderPriceTable(newSegId);
    }
  }
  logMsg(`成功新增地段 ${newSegId}：${name}`);
});

function getPriceField(fieldIdx: number, segId: number): number {
  if (!priceDataView || segId <= 0 || segId >= PRICE_SEG_COUNT) return 0;
  return priceDataView.getUint16(fieldIdx * PRICE_FIELD_SIZE + segId * 2, true);
}

function setPriceField(fieldIdx: number, segId: number, val: number): void {
  if (!priceDataView || segId <= 0 || segId >= PRICE_SEG_COUNT) return;
  priceDataView.setUint16(fieldIdx * PRICE_FIELD_SIZE + segId * 2, val, true);
}

function renderPriceTable(segId: number): void {
  (document.getElementById('priceSegLabel') as HTMLSpanElement).textContent =
    segId > 0 ? `${segId} - ${getSegName(segId)}` : '無（非土地）';
  const tbody = document.getElementById('priceTbody') as HTMLTableSectionElement;
  tbody.innerHTML = '';
  if (segId <= 0) {
    tbody.innerHTML = '<tr><td colspan="2" style="color:#888">此格非土地</td></tr>';
    return;
  }
  const isExtra = segId >= PRICE_SEG_COUNT;
  PRICE_FIELDS.forEach((label, fi) => {
    let val: number;
    if (isExtra) {
      val = (extraPriceData[segId] && extraPriceData[segId][fi] != null) ? extraPriceData[segId][fi] : 0;
    } else {
      val = priceData ? getPriceField(fi, segId) : 0;
    }
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td><input type="number" min="0" max="65535" value="${val}" data-fi="${fi}" data-seg="${segId}" data-extra="${isExtra ? 1 : 0}"></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      const fi = parseInt(target.dataset.fi || '0');
      const seg = parseInt(target.dataset.seg || '0');
      const v = parseInt(target.value) || 0;
      if (target.dataset.extra === '1') {
        if (!extraPriceData[seg]) extraPriceData[seg] = {};
        extraPriceData[seg][fi] = v;
      } else {
        setPriceField(fi, seg, v);
      }
    });
  });
}

let warnings: WarningMsg[] = [];
function runValidation(): void {
  warnings = [];
  if (!isSaveLoaded || !locData) { renderWarnList(); return; }

  const locUsage: Record<number, number[]> = {};
  for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
    const lid = mapGrid[i];
    if (lid === 0) continue;
    if (!locUsage[lid]) locUsage[lid] = [];
    locUsage[lid].push(i);
  }

  for (const [lidStr, cells] of Object.entries(locUsage)) {
    const lid = parseInt(lidStr);
    if (cells.length > 1) {
      const coords = cells.map(ci => `(${ci % GRID_COLS},${Math.floor(ci / GRID_COLS)})`).join(', ');
      warnings.push({ type: 'dup', cells, msg: `地點 ${lid} 重複用於 ${coords}` });
    }
  }

  for (let ci = 0; ci < GRID_COLS * GRID_ROWS; ci++) {
    const lid = mapGrid[ci];
    if (lid <= 0) continue;
    const gx = ci % GRID_COLS, gy = Math.floor(ci / GRID_COLS);
    const dirs = [
      { label: '左', field: LOC_FIELDS.LEFT, nx: gx - 1, ny: gy },
      { label: '右', field: LOC_FIELDS.RIGHT, nx: gx + 1, ny: gy },
      { label: '上', field: LOC_FIELDS.UP, nx: gx, ny: gy - 1 },
      { label: '下', field: LOC_FIELDS.DOWN, nx: gx, ny: gy + 1 },
    ];
    dirs.forEach(d => {
      const target = getLocField(d.field, lid);
      if (target === 0) return;
      if (d.nx < 0 || d.nx >= GRID_COLS || d.ny < 0 || d.ny >= GRID_ROWS) {
        warnings.push({ type: 'dir', cells: [ci], msg: `地點 ${lid} (${gx},${gy}) 往${d.label}→地點 ${target}，但超出地圖邊界` });
        return;
      }
      const neighborLid = mapGrid[d.ny * GRID_COLS + d.nx];
      if (neighborLid !== target) {
        warnings.push({ type: 'dir', cells: [ci], msg: `地點 ${lid} (${gx},${gy}) 往${d.label}→地點 ${target}，但鄰格是地點 ${neighborLid}` });
      }
    });
  }

  const warnTab = document.querySelector('[data-tab="tabWarn"]') as HTMLDivElement;
  if (warnTab) {
    warnTab.textContent = warnings.length > 0 ? `⚠ 警告 (${warnings.length})` : '✅ 無警告';
  }
  renderWarnList();
}

function renderWarnList(): void {
  const list = document.getElementById('warnList') as HTMLDivElement;
  if (warnings.length === 0) { list.innerHTML = '<div style="color:#4ec9b0">✅ 目前無警告</div>'; return; }
  list.innerHTML = '';
  warnings.forEach(w => {
    const div = document.createElement('div');
    div.textContent = w.msg;
    div.addEventListener('click', () => {
      if (w.cells && w.cells.length > 0) {
        const ci = w.cells[0];
        const gx = ci % GRID_COLS, gy = Math.floor(ci / GRID_COLS);
        simulateSelectCell(gx, gy);
      }
    });
    list.appendChild(div);
  });
}

function getLocField(field_offset: number, loc_id: number): number {
  if (!locDataView || loc_id <= 0 || loc_id >= LOC_COUNT) return 0;
  return locDataView.getUint16(field_offset + loc_id * 2, true);
}

function setLocField(field_offset: number, loc_id: number, val: number): void {
  if (!locDataView || loc_id <= 0 || loc_id >= LOC_COUNT) return;
  locDataView.setUint16(field_offset + loc_id * 2, val, true);
}

function simulateSelectCell(gx: number, gy: number): void {
  openEditPanel(gx, gy);
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  const tabLocBtn = document.querySelector('[data-tab="tabLoc"]') as HTMLDivElement;
  if (tabLocBtn) tabLocBtn.classList.add('active');
  const tabLoc = document.getElementById('tabLoc');
  if (tabLoc) tabLoc.classList.add('active');
}

function buildTilePicker(): void {
  const wrap = document.getElementById('tilePickerWrap') as HTMLDivElement;
  if (wrap.children.length > 0) return;
  const totalTiles = Math.floor(mapTilesData.length / 480);
  for (let t = 0; t < totalTiles; t++) {
    const c = document.createElement('canvas');
    c.width = TILE_W; c.height = TILE_H;
    c.className = 'tile-btn';
    c.title = `圖塊 #${t}`;
    const tctx = c.getContext('2d') as CanvasRenderingContext2D;
    const img = tctx.createImageData(TILE_W, TILE_H);
    const src = t * 480;
    for (let p = 0; p < 480; p++) {
      const ci = mapTilesData[src + p];
      img.data[p * 4] = palette[ci * 3];
      img.data[p * 4 + 1] = palette[ci * 3 + 1];
      img.data[p * 4 + 2] = palette[ci * 3 + 2];
      img.data[p * 4 + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    c.addEventListener('click', () => {
      document.querySelectorAll('.tile-btn').forEach(b => b.classList.remove('selected'));
      c.classList.add('selected');
      selectedTileIndex = t;
      if (selectedGridX >= 0) {
        mapLayout[selectedGridY * GRID_COLS + selectedGridX] = t;
        checkAndRenderRealMap();
        ctx.strokeStyle = '#e51400';
        ctx.lineWidth = 2;
        ctx.strokeRect(selectedGridX * TILE_W, selectedGridY * TILE_H, TILE_W, TILE_H);
        ctx.lineWidth = 1;
      }
    });
    wrap.appendChild(c);
  }
}

function openEditPanel(gridX: number, gridY: number): void {
  selectedGridX = gridX;
  selectedGridY = gridY;

  const cellIndex = gridY * GRID_COLS + gridX;
  const locId = mapGrid[cellIndex];
  const tileId = mapLayout[cellIndex];

  const isLand = locId > 0x32;
  const typeStr = locId === 0 ? '非地點' : (isLand ? '土地' : '特殊地點');

  checkAndRenderRealMap();
  ctx.strokeStyle = '#e51400';
  ctx.lineWidth = 2;
  ctx.strokeRect(gridX * TILE_W, gridY * TILE_H, TILE_W, TILE_H);
  ctx.lineWidth = 1;

  const spId = locId > 0 && locData ? getLocField(LOC_FIELDS.SPECIAL, locId) : 0;
  const segId2 = locId > 0 && locData ? getLocField(LOC_FIELDS.SEGMENT, locId) : 0;
  infoBox.innerHTML = `
                網格 (${gridX}, ${gridY})　地點：<b>${locId}</b>　圖塊：<b>${tileId}</b><br>
                屬性：<span style="color:#d16969">${typeStr}</span>
                ${locId > 0 ? `　<b style="color:#ce9178">${getSpecialName(spId)}</b>(代號${spId})` : ''}
                ${segId2 > 0 ? `　地段<b>${segId2}</b> ${getSegName(segId2)}` : ''}
            `;

  (document.getElementById('editPanel') as HTMLDivElement).style.display = 'block';
  (document.getElementById('editTitle') as HTMLHeadingElement).textContent = `編輯 (${gridX}, ${gridY})  地點 ${locId}`;

  if (mapTilesData.length > 0) {
    buildTilePicker();
    selectedTileIndex = tileId;
    document.querySelectorAll('.tile-btn').forEach((b, i) => b.classList.toggle('selected', i === tileId));
    const wrap = document.getElementById('tilePickerWrap') as HTMLDivElement;
    const sel = wrap.children[tileId] as HTMLElement;
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  // 幹，這裡把你漏掉的 UI 連動更新補上
  (document.getElementById('editLocId') as HTMLInputElement).value = locId.toString();
  if (locId > 0 && locData) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, locId);
    const spId = getLocField(LOC_FIELDS.SPECIAL, locId);
    (document.getElementById('editSegId') as HTMLInputElement).value = segId.toString();
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = getSegName(segId);
    (document.getElementById('editSpecial') as HTMLInputElement).value = spId.toString();
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = getSpecialName(spId);
    (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, locId).toString();
    (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, locId).toString();
    (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, locId).toString();
    const unk3 = getLocField(LOC_FIELDS.UNK3, locId);
    (document.getElementById('editUnk3') as HTMLSelectElement).value = unk3.toString();
    const suggest = detectMarkerDir(locId);
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;
    (document.getElementById('editDirLeft') as HTMLInputElement).value = getLocField(LOC_FIELDS.LEFT, locId).toString();
    (document.getElementById('editDirUp') as HTMLInputElement).value = getLocField(LOC_FIELDS.UP, locId).toString();
    (document.getElementById('editDirRight') as HTMLInputElement).value = getLocField(LOC_FIELDS.RIGHT, locId).toString();
    (document.getElementById('editDirDown') as HTMLInputElement).value = getLocField(LOC_FIELDS.DOWN, locId).toString();
    renderPriceTable(segId);
  } else {
    ['editSegId', 'editSpecial', 'editUnk9', 'editUnkA', 'editUnkB', 'editUnk3', 'editDirLeft', 'editDirUp', 'editDirRight', 'editDirDown'].forEach(id => {
      (document.getElementById(id) as HTMLInputElement).value = '0';
    });
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = '建議方向：-';
    renderPriceTable(0);
  }
  validateDirWarnings(locId, gridX, gridY);
}

function setLocWithCoords(locId: number, gridX: number, gridY: number): void {
  if (locId <= 0 || !locData) return;
  const existingX = getLocField(LOC_FIELDS.X, locId);
  const existingY = getLocField(LOC_FIELDS.Y, locId);

  // 💥 幹！就是這行防呆把你搞死了！
  if (existingX === 0 && existingY === 0) {
    setLocField(LOC_FIELDS.X, locId, gridX);
    setLocField(LOC_FIELDS.Y, locId, gridY);
    logMsg(`地點 ${locId} 座標自動設為 (${gridX}, ${gridY})`);
  }
}

(document.getElementById('editLocId') as HTMLInputElement).addEventListener('input', function (e: Event) {
  if (selectedGridX < 0) return;
  const target = e.target as HTMLInputElement;
  const newLocId = parseInt(target.value) || 0;
  mapGrid[selectedGridY * GRID_COLS + selectedGridX] = newLocId;
  setLocWithCoords(newLocId, selectedGridX, selectedGridY);
  (document.getElementById('editTitle') as HTMLHeadingElement).textContent = `編輯 (${selectedGridX}, ${selectedGridY})  地點 ${newLocId}`;
  if (newLocId > 0 && locData) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, newLocId);  // ← locId → newLocId
    const spId = getLocField(LOC_FIELDS.SPECIAL, newLocId);   // ← locId → newLocId
    if (segId > 0) applySegmentDerivedFields(newLocId, segId);
    (document.getElementById('editSegId') as HTMLInputElement).value = segId.toString();
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = getSegName(segId);
    (document.getElementById('editSpecial') as HTMLInputElement).value = spId.toString();
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = getSpecialName(spId);
    (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, newLocId).toString();
    (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, newLocId).toString();
    (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, newLocId).toString();
    const unk3 = getLocField(LOC_FIELDS.UNK3, newLocId);
    (document.getElementById('editUnk3') as HTMLSelectElement).value = unk3.toString();
    const suggest = detectMarkerDir(newLocId);
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;
    (document.getElementById('editDirLeft') as HTMLInputElement).value = getLocField(LOC_FIELDS.LEFT, newLocId).toString();   // ← locId → newLocId
    (document.getElementById('editDirUp') as HTMLInputElement).value = getLocField(LOC_FIELDS.UP, newLocId).toString();       // ← locId → newLocId
    (document.getElementById('editDirRight') as HTMLInputElement).value = getLocField(LOC_FIELDS.RIGHT, newLocId).toString(); // ← locId → newLocId
    (document.getElementById('editDirDown') as HTMLInputElement).value = getLocField(LOC_FIELDS.DOWN, newLocId).toString();   // ← locId → newLocId
  } else {
    ['editSegId', 'editSpecial', 'editUnk9', 'editUnkA', 'editUnkB', 'editUnk3', 'editDirLeft', 'editDirUp', 'editDirRight', 'editDirDown'].forEach(id => {
      (document.getElementById(id) as HTMLInputElement).value = '0';
    });
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = '建議方向：-';
  }

  const segForPrice = newLocId > 0 ? getLocField(LOC_FIELDS.SEGMENT, newLocId) : 0;  // ← locId → newLocId
  renderPriceTable(segForPrice);

  validateDirWarnings(newLocId, selectedGridX, selectedGridY);  // ← locId/gridX/gridY 全換
});

(document.getElementById('editSegId') as HTMLInputElement).addEventListener('input', function (e: Event) {
  if (selectedGridX < 0) return;
  const target = e.target as HTMLInputElement;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  const segId = parseInt(target.value) || 0;
  (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = getSegName(segId);
  if (locId > 0) {
    if (segId > 0) {
      applySegmentDerivedFields(locId, segId);
      (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, locId).toString();
      (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, locId).toString();
      (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, locId).toString();
      (document.getElementById('editUnk3') as HTMLSelectElement).value = getLocField(LOC_FIELDS.UNK3, locId).toString();
      const suggest = detectMarkerDir(locId);
      (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;
    } else {
      setLocField(LOC_FIELDS.SEGMENT, locId, 0);
    }
    renderPriceTable(segId);
  }
});

(document.getElementById('editUnk9') as HTMLInputElement).addEventListener('input', function (e: Event) {
  if (selectedGridX < 0) return;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  if (locId > 0) setLocField(LOC_FIELDS.UNK9, locId, parseInt((e.target as HTMLInputElement).value) || 0);
});

(document.getElementById('editUnkA') as HTMLInputElement).addEventListener('input', function (e: Event) {
  if (selectedGridX < 0) return;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  if (locId > 0) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, locId);
    const v = parseInt((e.target as HTMLInputElement).value) || 0;
    if (segId > 0) applyFieldToSegment(segId, LOC_FIELDS.UNKA, v);
    else setLocField(LOC_FIELDS.UNKA, locId, v);
  }
});

(document.getElementById('editUnkB') as HTMLInputElement).addEventListener('input', function (e: Event) {
  if (selectedGridX < 0) return;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  if (locId > 0) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, locId);
    const v = parseInt((e.target as HTMLInputElement).value) || 0;
    if (segId > 0) applyFieldToSegment(segId, LOC_FIELDS.UNKB, v);
    else setLocField(LOC_FIELDS.UNKB, locId, v);
  }
});

(document.getElementById('editUnk3') as HTMLSelectElement).addEventListener('change', function (e: Event) {
  if (selectedGridX < 0) return;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  if (locId > 0) {
    const v = parseInt((e.target as HTMLSelectElement).value) || 0;
    setLocField(LOC_FIELDS.UNK3, locId, v);
  }
});

function dirInputHandler(fieldConst: number) {
  return function (e: Event) {
    if (selectedGridX < 0) return;
    const target = e.target as HTMLInputElement;
    const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
    if (locId > 0) { setLocField(fieldConst, locId, parseInt(target.value) || 0); }
    validateDirWarnings(locId, selectedGridX, selectedGridY);
  };
}
(document.getElementById('editDirLeft') as HTMLInputElement).addEventListener('input', dirInputHandler(LOC_FIELDS.LEFT));
(document.getElementById('editDirUp') as HTMLInputElement).addEventListener('input', dirInputHandler(LOC_FIELDS.UP));
(document.getElementById('editDirRight') as HTMLInputElement).addEventListener('input', dirInputHandler(LOC_FIELDS.RIGHT));
(document.getElementById('editDirDown') as HTMLInputElement).addEventListener('input', dirInputHandler(LOC_FIELDS.DOWN));

function validateDirWarnings(locId: number, gx: number, gy: number): void {
  const msgs: string[] = [];
  const warnMsgEl = document.getElementById('dirWarnMsg') as HTMLDivElement;
  if (locId <= 0 || !locData) { warnMsgEl.textContent = ''; return; }
  const dirs = [
    { label: '左', field: LOC_FIELDS.LEFT, nx: gx - 1, ny: gy },
    { label: '右', field: LOC_FIELDS.RIGHT, nx: gx + 1, ny: gy },
    { label: '上', field: LOC_FIELDS.UP, nx: gx, ny: gy - 1 },
    { label: '下', field: LOC_FIELDS.DOWN, nx: gx, ny: gy + 1 },
  ];
  dirs.forEach(d => {
    const target = getLocField(d.field, locId);
    if (target === 0) return;
    if (d.nx < 0 || d.nx >= GRID_COLS || d.ny < 0 || d.ny >= GRID_ROWS) {
      msgs.push(`⚠ 往${d.label}→${target} 超出地圖`); return;
    }
    const neighborLid = mapGrid[d.ny * GRID_COLS + d.nx];
    if (neighborLid !== target) msgs.push(`⚠ 往${d.label}→${target}，鄰格實際是 ${neighborLid}`);
  });
  warnMsgEl.textContent = msgs.join('　');
}

canvas.addEventListener('mousedown', function (e: MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  const gridX = Math.floor(x / TILE_W);
  const gridY = Math.floor(y / TILE_H);
  if (gridX < 0 || gridX >= GRID_COLS || gridY < 0 || gridY >= GRID_ROWS) return;

  openEditPanel(gridX, gridY);
});

function replaceGroupInDsk(dskBytes: Uint8Array, groupPointers: number[], groupIndex: number, newData: Uint8Array) {
  const DSK_DATA_BASE = 7;
  const newCompressed = compressGeneralData(newData);
  const groupStart = groupPointers[groupIndex];
  const groupEnd = (groupIndex + 1 < groupPointers.length)
    ? groupPointers[groupIndex + 1] : dskBytes.length;
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

function rebuildDskBuffer(): ArrayBuffer | null {
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

  if (priceData && Object.keys(extraPriceData).length > 0) {
    let maxSeg = PRICE_SEG_COUNT - 1;
    Object.keys(extraPriceData).forEach(k => { if (parseInt(k) > maxSeg) maxSeg = parseInt(k); });
    const newSegCount = maxSeg + 1;
    const newFieldSize = newSegCount * 2;
    const newPriceArr = new Uint8Array(PRICE_FIELD_COUNT * newSegCount * 2);
    const newPriceDV = new DataView(newPriceArr.buffer);
    for (let fi = 0; fi < PRICE_FIELD_COUNT; fi++) {
      for (let si = 0; si < PRICE_SEG_COUNT; si++) {
        if (priceDataView) {
          newPriceDV.setUint16(fi * newFieldSize + si * 2, priceDataView.getUint16(fi * PRICE_FIELD_SIZE + si * 2, true), true);
        }
      }
    }
    Object.entries(extraPriceData).forEach(([segStr, fields]) => {
      const si = parseInt(segStr);
      Object.entries(fields).forEach(([fiStr, v]) => {
        newPriceDV.setUint16(parseInt(fiStr) * newFieldSize + si * 2, v, true);
      });
    });
    priceData = newPriceArr; priceDataView = newPriceDV;
  }

  if (priceData) {
    const r = replaceGroupInDsk(curBytes, curPtrs, 7, priceData);
    curBytes = r.bytes; curPtrs = r.ptrs;
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

function downloadBuffer(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

(document.getElementById('exportDskBtn') as HTMLButtonElement).addEventListener('click', function () {
  if (!isSaveLoaded) { logMsg("還沒載入 DSK！"); return; }
  const syncFn = (window as any).syncMarkerTilesFromOwnership;
  if (typeof syncFn === 'function') {
    const touched = syncFn(1, 2);
    logMsg(`匯出前自動同步購地標記圖塊：${touched} 格。`);
  }
  const buf = rebuildDskBuffer();
  if (buf) { downloadBuffer(buf, 'SAVE_?.DSK'); logMsg("DSK 匯出完成！"); }
});

(document.getElementById('syncMarkerBtn') as HTMLButtonElement).addEventListener('click', function () {
  const syncFn = (window as any).syncMarkerTilesFromOwnership;
  if (typeof syncFn !== 'function') {
    logMsg("同步函式尚未就緒（請稍後再試）");
    return;
  }
  syncFn(1, 2);
  logMsg("已依 OWNER/HOUSE 自動同步 loc+950 的購地標記圖塊。");
});

// === 土地 ID / 地段 ID / 圖塊 ID 關係分析 ===
// 用法：載入地圖後在 console 跑 analyzeLandTileOffset()
(window as any).analyzeLandTileOffset = function () {
  if (!mapGrid.length || !mapLayout.length) {
    console.warn("還沒載入地圖資料，先匯入 DSK/PAK 再分析。");
    return;
  }
  if (!locDataView) {
    console.warn("還沒載入 locData，無法讀取地段編號。");
    return;
  }

  type Cell = { gx: number; gy: number; tileId: number; };
  const byLoc = new Map<number, Cell[]>();
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      const idx = gy * GRID_COLS + gx;
      const locId = mapGrid[idx];
      if (locId <= 0) continue;
      const tileId = mapLayout[idx];
      if (!byLoc.has(locId)) byLoc.set(locId, []);
      byLoc.get(locId)!.push({ gx, gy, tileId });
    }
  }

  let landCount = 0;
  let pairCount950 = 0;
  let changedTilePairs = 0;
  let ownedCount = 0;
  let ownedAndMarkerChanged = 0;
  const examples: string[] = [];
  const markerTileHist = new Map<number, number>();

  for (let base = 0x33; base <= LOC_COUNT; base++) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, base);
    if (segId <= 0) continue; // 非土地跳過
    landCount++;

    const baseCells = byLoc.get(base) || [];
    const markCells = byLoc.get(base + 950) || [];
    if (markCells.length === 0) continue;
    pairCount950++;

    const baseTileSet = new Set(baseCells.map(c => c.tileId));
    const markTileSet = new Set(markCells.map(c => c.tileId));
    const different = [...markTileSet].some(t => !baseTileSet.has(t));
    if (different) changedTilePairs++;
    markTileSet.forEach((t) => markerTileHist.set(t, (markerTileHist.get(t) || 0) + 1));

    const owner = getLocField(LOC_FIELDS.OWNER, base);
    const house = getLocField(LOC_FIELDS.HOUSE, base);
    const isOwned = owner > 0 || house > 0;
    if (isOwned) {
      ownedCount++;
      if (different) ownedAndMarkerChanged++;
    }

    if (examples.length < 12) {
      const bt = [...baseTileSet].join('/');
      const mt = [...markTileSet].join('/');
      examples.push(`loc ${base} -> ${base + 950} | seg=${segId} owner=${owner} house=${house} | baseTile=[${bt || '-'}] markTile=[${mt || '-'}]`);
    }
  }

  console.log("=== 購地標記分析（你描述的規則）===");
  console.log(`土地總數(依 segId>0)：${landCount}`);
  console.log(`有找到 loc+950 對應格的土地數：${pairCount950}`);
  console.log(`其中「標記格 tile 與原始格 tile 不同」的土地數：${changedTilePairs}`);
  console.log(`已持有土地數(owner>0 或 house>0)：${ownedCount}`);
  console.log(`已持有且標記格 tile 確實不同：${ownedAndMarkerChanged}`);
  const hist = [...markerTileHist.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `tile${t}:${c}`).join(', ');
  console.log(`標記格 tile 分佈：${hist || '-'}`);
  console.log("說明：locId 54 本身不變；被標記/變色的是 locId 1004 (=54+950) 這一格的 tile。");
  console.log("\n範例（最多 12 筆）：");
  examples.forEach(e => console.log(e));

  const loc54Base = byLoc.get(54) || [];
  const loc1004 = byLoc.get(1004) || [];
  console.log(`\nloc54 格數=${loc54Base.length}, tile=[${[...new Set(loc54Base.map(c => c.tileId))].join('/') || '-'}]`);
  console.log(`loc1004 格數=${loc1004.length}, tile=[${[...new Set(loc1004.map(c => c.tileId))].join('/') || '-'}]`);
};

// 用來直接看「購買」時 54 與 1004 的連動（owner 存在 base loc，圖塊變化在 base+950）
// 注意：預設不自動改 house，避免把「買地」誤當成「蓋房」。
(window as any).simulatePurchaseLink = function (baseLocId: number, ownerId: number = 1, purchasedTileId: number = 2, houseLevel?: number) {
  if (!locDataView || !mapGrid.length || !mapLayout.length) {
    console.warn("請先載入 DSK/PAK。");
    return;
  }
  if (baseLocId <= 0 || baseLocId > LOC_COUNT) {
    console.warn(`baseLocId 超出範圍: ${baseLocId}`);
    return;
  }

  const markerLocId = baseLocId + 950;
  const markerIndices: number[] = [];
  for (let i = 0; i < mapGrid.length; i++) {
    if (mapGrid[i] === markerLocId) markerIndices.push(i);
  }

  const beforeOwner = getLocField(LOC_FIELDS.OWNER, baseLocId);
  const beforeHouse = getLocField(LOC_FIELDS.HOUSE, baseLocId);
  const beforeTiles = markerIndices.map(i => mapLayout[i]);

  setLocField(LOC_FIELDS.OWNER, baseLocId, ownerId);
  if (typeof houseLevel === 'number' && houseLevel >= 0) {
    setLocField(LOC_FIELDS.HOUSE, baseLocId, houseLevel);
  }
  markerIndices.forEach(i => { mapLayout[i] = purchasedTileId; });

  checkAndRenderRealMap();
  const maybeRefreshInfoPanel = (window as any).refreshInfoPanel;
  if (typeof maybeRefreshInfoPanel === 'function') maybeRefreshInfoPanel();

  const afterOwner = getLocField(LOC_FIELDS.OWNER, baseLocId);
  const afterHouse = getLocField(LOC_FIELDS.HOUSE, baseLocId);
  const afterTiles = markerIndices.map(i => mapLayout[i]);
  console.log(`simulatePurchaseLink: baseLoc=${baseLocId}, markerLoc=${markerLocId}`);
  console.log(`owner: ${beforeOwner} -> ${afterOwner}, house: ${beforeHouse} -> ${afterHouse}`);
  console.log(`marker tiles: [${beforeTiles.join('/') || '-'}] -> [${afterTiles.join('/') || '-'}]`);
};

// 依據 loc 資料中的 OWNER/HOUSE 狀態，批次同步 loc+950 的標記圖塊
// 預設規則：空地(tile=1)、已購地(tile=2)
(window as any).syncMarkerTilesFromOwnership = function (emptyTileId: number = 1, ownedTileId: number = 2): number {
  if (!locDataView || !mapGrid.length || !mapLayout.length) {
    console.warn("請先載入 DSK/PAK。");
    return 0;
  }
  let touched = 0;
  for (let base = 0x33; base <= LOC_COUNT; base++) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, base);
    if (segId <= 0) continue;
    const owner = getLocField(LOC_FIELDS.OWNER, base);
    const house = getLocField(LOC_FIELDS.HOUSE, base);
    const targetTile = (owner > 0 || house > 0) ? ownedTileId : emptyTileId;
    const markerLocId = base + 950;
    for (let i = 0; i < mapGrid.length; i++) {
      if (mapGrid[i] !== markerLocId) continue;
      if (mapLayout[i] !== targetTile) {
        mapLayout[i] = targetTile;
        touched++;
      }
    }
  }
  checkAndRenderRealMap();
  console.log(`syncMarkerTilesFromOwnership 完成，更新 ${touched} 個標記圖塊。`);
  return touched;
};

// === 新增：除以 0 地雷掃描器 ===
(window as any).scanZero = function () {
  if (!locDataView) {
    console.error("幹，DSK 存檔還沒載入啦！");
    return;
  }

  let warnings: string[] = [];
  console.log("=== 開始掃描大富翁 3 除以 0 地雷 ===");

  // 你說你 ID 寫到 124，我們就掃 1 到 124
  for (let id = 1; id <= 124; id++) {
    let x = getLocField(LOC_FIELDS.X, id);
    let y = getLocField(LOC_FIELDS.Y, id);
    let left = getLocField(LOC_FIELDS.LEFT, id);
    let up = getLocField(LOC_FIELDS.UP, id);
    let right = getLocField(LOC_FIELDS.RIGHT, id);
    let down = getLocField(LOC_FIELDS.DOWN, id);
    let segId = getLocField(LOC_FIELDS.SEGMENT, id);

    // 檢查 1: 物理座標跟邏輯方向是否矛盾 (斜率分母為 0)
    // 如果有向左或向右的路，X 座標絕對不能一樣！
    if (left > 0) {
      let targetX = getLocField(LOC_FIELDS.X, left);
      if (Math.abs(x - targetX) === 0) warnings.push(`[地點 ${id} -> 左 ${left}] 幹！X座標一模一樣 (${x})，水平移動距離是 0！`);
    }
    if (right > 0) {
      let targetX = getLocField(LOC_FIELDS.X, right);
      if (Math.abs(x - targetX) === 0) warnings.push(`[地點 ${id} -> 右 ${right}] 幹！X座標一模一樣 (${x})，水平移動距離是 0！`);
    }
    // 如果有向上或向下的路，Y 座標絕對不能一樣！
    if (up > 0) {
      let targetY = getLocField(LOC_FIELDS.Y, up);
      if (Math.abs(y - targetY) === 0) warnings.push(`[地點 ${id} -> 上 ${up}] 幹！Y座標一模一樣 (${y})，垂直移動距離是 0！`);
    }
    if (down > 0) {
      let targetY = getLocField(LOC_FIELDS.Y, down);
      if (Math.abs(y - targetY) === 0) warnings.push(`[地點 ${id} -> 下 ${down}] 幹！Y座標一模一樣 (${y})，垂直移動距離是 0！`);
    }

    // 檢查 2: 死胡同檢查 (只有一條路，被引擎剃除來時路後，出路變 0 條)
    let paths = (left > 0 ? 1 : 0) + (up > 0 ? 1 : 0) + (right > 0 ? 1 : 0) + (down > 0 ? 1 : 0);
    if (paths === 1) {
      warnings.push(`[地點 ${id}] 靠背，這是死胡同！只有一條路進出，尋路分母會變 0！`);
    }

    // 檢查 3: 地段價格是否為 0 (AI 估價分母為 0)
    // 假設每個地段價格資料長度是 24 bytes (空地、1~5級房屋等6個價格 * 4 bytes，或依你的結構)
    // 我們抓第一個欄位 (空地買價) 看看是不是 0
    if (segId > 0 && segId < 45 && typeof priceDataView !== 'undefined' && priceDataView) {
      try {
        // 這裡套用你原本讀取地段 0 級價格的邏輯，這邊我寫個大概，如有 getPrice() 請替換
        let basePrice = priceDataView.getUint16(segId * 24, true);
        if (basePrice === 0) {
          warnings.push(`[地點 ${id}] 屬於地段 ${segId}，但地段買價是 0！AI 算 C/P 值會暴斃！`);
        }
      } catch (e) { }
    }
  }

  // 結論輸出
  if (warnings.length > 0) {
    console.warn("🚨 掃描完成！抓到以下可能導致 division by zero 的地雷：\n\n" + warnings.join("\n"));
  } else {
    console.log("✅ 掃描完成！沒抓到明顯的除以 0 錯誤。如果還當機，可能是 X/Y 座標沒乘上像素倍率 (網格直存存檔)！");
  }
};