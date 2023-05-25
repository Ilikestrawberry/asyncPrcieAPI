// 1. 함수 간 비동기 작동을 위해 필요한 경우 전역 변수 설정
// 2. 하드코딩으로 처리할 수 있는 작업은 코드를 쓰지 않고 직접 처리(ex. 폴더 생성, 요청 포멧, symbol 등..)
// 3. 오더북을 가져올 때 발생할 수 있는 에러 시나리오를 처리할 수 있도록 작성
// 4. 연결이 끊겼을 경우에도 csv 저장은 유지
// 5. csv는 1초마다 저장되지만 orderbook과 스프레드는 정보가 들어올 때 마다 갱신

const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const util = require("util");
const datetime = require("node-datetime");

// datetime.setOffsetInHours(9); // 해외 거래소의 경우 9시간 더해서 시간 출력

// ------------------------------------------global variable
// 고팍스 관련 전역변수
let gGxReconnectCount = 0; // 연결이 끊겼을 경우, 재접속을 시도한 횟수
let gGxWebsocket = {};
const gGxOrderbook = {
    "BTC-KRW": {
        bid: [],
        ask: [],
    },
};

let gBtxReconnectCount = 0;
let gBtxWebsocket = {};
const gBtxOrderbook = {
    "BTC-KRW": {
        bid: [],
        ask: [],
    },
};

// log save
const gThisFile = path.basename(__filename);
let logStdout = process.stdout;

console.log = function () {
    let currentTime = new Date();
    let times = datetime.create(currentTime);
    let date = times.format("Y-m-d");
    let time = times.format("H:M:S:N");
    let fileName = `./log/log_${gThisFile}_${date}.txt`;
    let logFile = fs.createWriteStream(fileName, { flags: "a" });
    logFile.write(time + " : " + util.format.apply(null, arguments) + "\r\n");
    logStdout.write(time + " : " + util.format.apply(null, arguments) + "\r\n");
    logFile.end();
};

console.error = function () {
    let currentTime = new Date();
    let times = datetime.create(currentTime);
    let date = times.format("Y-m-d");
    let time = times.format("H:M:S:N");
    let fileName = `./log/log_${gThisFile}_${date}_error.txt`;
    let logFile = fs.createWriteStream(fileName, { flags: "a" });
    logFile.write(
        date + " " + time + " : " + util.format.apply(null, arguments) + "\r\n"
    );
    logStdout.write(time + " : " + util.format.apply(null, arguments) + "\r\n");
    logFile.end();
};

// process 에러가 발생하면 websocket을 재연결
process.on("uncaughtException", (err, origin) => {
    gGxWebsocket.removeAllListeners();
    gBtxWebsocket.removeAllListeners();

    if (err.code == "ECONNRESET") {
        reconnectBtxWebsocket();
        reconnectGxWebsocket();
        console.log("connection reset", err);
    } else {
        reconnectBtxWebsocket();
        reconnectGxWebsocket();
        console.log("unknown error: ", err, origin);
    }
});

// ---------------------------------------------------------------------------------------Gx function
// 고팍스는 첫 연결 때 SubscribeToOrderBook을 보내주고 그 이후로는 변화된 호가 정보만 보내줍니다.
function connectWebsocketGx() {
    gGxWebsocket = new WebSocket("wss://wsapi.gopax.co.kr");

    gGxWebsocket.on("open", () => {
        console.log("Websocket connected");
        gGxReconnectCount = 0;

        gGxWebsocket.send(
            JSON.stringify({
                i: "test",
                n: "SubscribeToOrderBook",
                o: { tradingPairName: "BTC-KRW" },
            })
        );
    });
    gGxWebsocket.on("message", (data) => {
        const ret = JSON.parse(data);
        // 고팍스 websocket은 20초마다 'ping'을 보내고, 접속을 유지하기 위해서 'pong' 응답을 보내야 함(고팍스 공식 api 참고)
        if (typeof ret == "string" && ret.startsWith("primus::ping::")) {
            gGxWebsocket.send(JSON.stringify(`primus::pong::${ret.slice(14)}`));
        } else {
            if (ret.hasOwnProperty("n")) {
                getOrderbookGx(ret);
            }
        }
    });

    gGxWebsocket.on("error", (error) => {
        gGxWebsocket.removeAllListeners();

        if (["ECONNREFUSED", "ETIMEDOUT"].includes(error.code)) {
            console.error(`Gx Connection error: ${error.code}`);
            gGxWebsocket.close();
        } else {
            console.error(`Gx error occurred: ${error}`);
            gGxWebsocket.close();
        }
    });

    gGxWebsocket.on("close", () => {
        console.log("Gx Websocket closed");
        gGxWebsocket.removeAllListeners();
        reconnectGxWebsocket();
    });
}

function reconnectGxWebsocket() {
    gGxReconnectCount++;

    setTimeout(() => {
        connectWebsocketGx();
    }, 1000); // 1초 후에 연결 재시도
    console.log(`Reconnecting Gx WebSocket (attempt ${gGxReconnectCount})...`);
}

function modifyDeltaBid(deltaBid) {
    for (let i = 0; i < deltaBid.length; i++) {
        const { price: deltaPrice, volume: deltaVolume } = deltaBid[i];
        if (deltaVolume == 0) {
            // vol=0 인 경우 같은 값을 가진 오더북을 삭제
            for (let j = 0; j < gGxOrderbook["BTC-KRW"].bid.length; j++) {
                if (deltaPrice == gGxOrderbook["BTC-KRW"].bid[j][0]) {
                    gGxOrderbook["BTC-KRW"].bid.splice(j, 1);
                    break;
                }
            }
        } else {
            // vol!=0 인 경우
            if (gGxOrderbook["BTC-KRW"].bid.length == 0) {
                // 오더북이 비어있는 경우 추가
                gGxOrderbook["BTC-KRW"].bid.push([deltaPrice, deltaVolume]);
                continue;
            } else if (
                deltaPrice <
                gGxOrderbook["BTC-KRW"].bid[
                    gGxOrderbook["BTC-KRW"].bid.length - 1
                ][0]
            ) {
                // 가장 낮은 bid인 경우 맨 뒤에 추가
                gGxOrderbook["BTC-KRW"].bid.splice(
                    gGxOrderbook["BTC-KRW"].bid.length,
                    0,
                    [deltaPrice, deltaVolume]
                );
                continue;
            } else if (deltaPrice > gGxOrderbook["BTC-KRW"].bid[0][0]) {
                // 가장 높은 bid인 경우 맨 앞에 추가
                gGxOrderbook["BTC-KRW"].bid.splice(0, 0, [
                    deltaPrice,
                    deltaVolume,
                ]);
                continue;
            }
            for (let j = 0; j < gGxOrderbook["BTC-KRW"].bid.length; j++) {
                // orderbook에 같은 값이 존재하는 경우엔 vol 업데이트
                if (deltaPrice == gGxOrderbook["BTC-KRW"].bid[j][0]) {
                    gGxOrderbook["BTC-KRW"].bid[j][1] = deltaVolume;
                    break;
                } else if (
                    j < gGxOrderbook["BTC-KRW"].bid.length - 1 &&
                    gGxOrderbook["BTC-KRW"].bid[j][0] > deltaPrice &&
                    deltaPrice > gGxOrderbook["BTC-KRW"].bid[j + 1][0]
                ) {
                    gGxOrderbook["BTC-KRW"].bid.splice(j + 1, 0, [
                        deltaPrice,
                        deltaVolume,
                    ]); // 사잇값이 새로 들어온 경우 추가
                    break;
                }
            }
        }
    }
}

function modifyDeltaAsk(deltaAsk) {
    for (let i = 0; i < deltaAsk.length; i++) {
        const { price: deltaPrice, volume: deltaVolume } = deltaAsk[i];
        if (deltaVolume == 0) {
            // vol=0 인 경우 같은 값을 가진 오더북을 삭제
            for (let j = 0; j < gGxOrderbook["BTC-KRW"].ask.length; j++) {
                if (deltaPrice == gGxOrderbook["BTC-KRW"].ask[j][0]) {
                    gGxOrderbook["BTC-KRW"].ask.splice(j, 1);
                    break;
                }
            }
        } else {
            // vol!=0 인 경우
            if (gGxOrderbook["BTC-KRW"].ask.length == 0) {
                // 오더북이 비어있는 경우 추가
                gGxOrderbook["BTC-KRW"].ask.push([deltaPrice, deltaVolume]);
                continue;
            } else if (
                deltaPrice >
                gGxOrderbook["BTC-KRW"].ask[
                    gGxOrderbook["BTC-KRW"].ask.length - 1
                ][0]
            ) {
                // 가장 높은 ask인 경우 맨 뒤에 추가
                gGxOrderbook["BTC-KRW"].ask.splice(
                    gGxOrderbook["BTC-KRW"].ask.length,
                    0,
                    [deltaPrice, deltaVolume]
                );
                continue;
            } else if (deltaPrice < gGxOrderbook["BTC-KRW"].ask[0][0]) {
                // 가장 낮은 ask인 경우 맨 앞에 추가
                gGxOrderbook["BTC-KRW"].ask.splice(0, 0, [
                    deltaPrice,
                    deltaVolume,
                ]);
                continue;
            }
            for (let j = 0; j < gGxOrderbook["BTC-KRW"].ask.length; j++) {
                // orderbook에 같은 값이 존재하는 경우엔 vol 업데이트
                if (deltaPrice == gGxOrderbook["BTC-KRW"].ask[j][0]) {
                    gGxOrderbook["BTC-KRW"].ask[j][1] = deltaVolume;
                    break;
                } else if (
                    j < gGxOrderbook["BTC-KRW"].ask.length - 1 &&
                    gGxOrderbook["BTC-KRW"].ask[j][0] < deltaPrice &&
                    deltaPrice < gGxOrderbook["BTC-KRW"].ask[j + 1][0]
                ) {
                    gGxOrderbook["BTC-KRW"].ask.splice(j + 1, 0, [
                        deltaPrice,
                        deltaVolume,
                    ]); // 사잇값이 새로 들어온 경우 추가
                    break;
                }
            }
        }
    }
}

function getOrderbookGx(orderbookData) {
    if (orderbookData.n == "SubscribeToOrderBook") {
        for (i = 0; i < orderbookData.o.bid.length; i++) {
            gGxOrderbook["BTC-KRW"].bid.push([
                orderbookData.o.bid[i].price,
                orderbookData.o.bid[i].volume,
            ]);
        }
        for (i = 0; i < orderbookData.o.ask.length; i++) {
            gGxOrderbook["BTC-KRW"].ask.push([
                orderbookData.o.ask[i].price,
                orderbookData.o.ask[i].volume,
            ]);
        }
    } else if (orderbookData.n == "OrderBookEvent") {
        const deltaBid = orderbookData.o.bid;
        const deltaAsk = orderbookData.o.ask;
        if (deltaBid.length > 0) {
            modifyDeltaBid(deltaBid);
        }
        if (deltaAsk.length > 0) {
            modifyDeltaAsk(deltaAsk);
        }
    }
}

function createCsvFileGx() {
    const filePath = "./csv/gx_spread_002v.csv";
    if (fs.existsSync(filePath)) {
        return;
    }
    const stream = fs.createWriteStream("./csv/gx_spread_002v.csv");
    let columnName = "time";
    for (i = 1; i <= 5; i++) {
        columnName += `, gx.btckrw.b${i}p, gx.btckrw.b${i}q, gx.btckrw.a${i}p, gx.btckrw.a${i}q`;
    }
    stream.write(`${columnName}\n`);
    stream.end();
}

function makeStringGx() {
    let string = "";
    if (gGxOrderbook["BTC-KRW"].bid.length != 0) {
        string = Date.now();
        for (i = 0; i < 5; i++) {
            string +=
                "," +
                gGxOrderbook["BTC-KRW"].bid[i][0] +
                "," +
                gGxOrderbook["BTC-KRW"].bid[i][1] +
                "," +
                gGxOrderbook["BTC-KRW"].ask[i][0] +
                "," +
                gGxOrderbook["BTC-KRW"].ask[i][1];
        }
        string += "\n";
        appendToCsvFileGx(string);
    }
}

function appendToCsvFileGx(string) {
    const stream = fs.createWriteStream("./csv/gx_spread_002v.csv", {
        flags: "a",
    });
    stream.write(string);
    stream.end();
}

// ------------------------------------------------------------------------------------Btx function
// 빗썸은 호가 스냅샷을 보내줍니다.
function connectWebsocketBtx() {
    gBtxWebsocket = new WebSocket("wss://pubwss.bithumb.com/pub/ws");

    gBtxWebsocket.on("open", () => {
        console.log("Btx Websocket connected");
        gBtxReconnectCount = 0;

        gBtxWebsocket.send(
            JSON.stringify({
                type: "orderbooksnapshot",
                symbols: ["BTC_KRW"],
            })
        );
    });

    gBtxWebsocket.on("message", (data) => {
        const ret = JSON.parse(data);
        // websocket에 접속한 초반에는 data에 아무 정보가 담겨있지 않기 때문에 if문으로 확인
        if (ret.hasOwnProperty("type")) {
            getOrderbookBtx(ret);
        }
    });

    gBtxWebsocket.on("error", (error) => {
        gBtxWebsocket.removeAllListeners();
        if (["ECONNREFUSED", "ETIMEDOUT"].includes(error.code)) {
            console.error(`Btx Connection error: ${error.code}`);
            gBtxWebsocket.close();
        } else {
            console.error(`Btx error occurred: ${error}`);
            gBtxWebsocket.close();
        }
    });

    gBtxWebsocket.on("close", () => {
        console.log("Btx Websocket closed");
        gBtxWebsocket.removeAllListeners();
        reconnectBtxWebsocket();
    });
}

function reconnectBtxWebsocket() {
    gBtxReconnectCount++;
    setTimeout(() => {
        connectWebsocketBtx();
    }, 1000); // 1초 후에 연결 재시도
    console.log(
        `Reconnecting Btx WebSocket (attempt ${gBtxReconnectCount})...`
    );
}

function getOrderbookBtx(data) {
    const bid = [];
    const ask = [];

    for (i = data.content.bids.length - 1; i >= 0; i--) {
        bid.push([data.content.bids[i][0], data.content.bids[i][1]]);
    }
    for (i = 0; i < data.content.asks.length; i++) {
        ask.push([data.content.asks[i][0], data.content.asks[i][1]]);
    }

    gBtxOrderbook["BTC-KRW"] = {
        bid,
        ask,
    };
}

function createCsvFileBtx() {
    const filePath = "./csv/btx_spread_002v.csv";
    if (fs.existsSync(filePath)) {
        return;
    }
    const stream = fs.createWriteStream("./csv/btx_spread_002v.csv");
    let columnName = "time";
    for (i = 1; i <= 5; i++) {
        columnName += `, btx.btckrw.b${i}p, btx.btckrw.b${i}q, btx.btckrw.a${i}p, btx.btckrw.a${i}q`;
    }
    stream.write(`${columnName}\n`);
    stream.end();
}

function makeStringBtx() {
    let string = "";
    if (gBtxOrderbook["BTC-KRW"].bid.length != 0) {
        string = Date.now();
        for (i = 0; i < 5; i++) {
            string +=
                "," +
                gBtxOrderbook["BTC-KRW"].bid[i][0] +
                "," +
                gBtxOrderbook["BTC-KRW"].bid[i][1] +
                "," +
                gBtxOrderbook["BTC-KRW"].ask[i][0] +
                "," +
                gBtxOrderbook["BTC-KRW"].ask[i][1];
        }
        string += "\n";

        appendToCsvFileBtx(string);
    }
}

function appendToCsvFileBtx(string) {
    // websocket과 연결이 되어 있는 상태에서만 csv를 갱신
    if (gBtxWebsocket.readyState == WebSocket.OPEN) {
        const stream = fs.createWriteStream("./csv/btx_spread_002v.csv", {
            flags: "a",
        });
        stream.write(string);
        stream.end();
    }
}

// ------------------------------------------------------------------------------------spread
// 고팍스에서 1호가 bid limit order를 걸어두고, 빗썸에서 bid 1호가를 매수하는 market order를 제출하는 시나리오
// -> 고팍스에서 팔고 빗썸에서 사서 차익을 얻는 보유 스프레드 전략
// 고팍스 수수료 +0.05%, 빗썸 수수료 -0.04% 가정
function spreadGxBtx() {
    const GxBtxbidSpread =
        gGxOrderbook["BTC-KRW"].bid[0][0] - gBtxOrderbook["BTC-KRW"].bid[0][0];
    const GxBtxbidFee = Math.ceil(
        -gGxOrderbook["BTC-KRW"].bid[0][0] * 0.0005 +
            gBtxOrderbook["BTC-KRW"].bid[0][0] * 0.0004
    ); // 올림처리
    const GxBtxaskSpread =
        gGxOrderbook["BTC-KRW"].ask[0][0] - gBtxOrderbook["BTC-KRW"].ask[0][0];
    const GxBtxaskFee = Math.ceil(
        -gGxOrderbook["BTC-KRW"].ask[0][0] * 0.0005 +
            gBtxOrderbook["BTC-KRW"].ask[0][0] * 0.0004
    );

    if (GxBtxbidSpread > GxBtxbidFee) {
        console.log("Bid Spread: ", GxBtxbidSpread, "   Fee: ", GxBtxbidFee);
    }
    if (GxBtxaskSpread > GxBtxaskFee) {
        console.log("Ask Spread: ", GxBtxaskSpread, "   Fee: ", GxBtxaskFee);
    }
}

// --------------------------------------------------------------------------------operation
createCsvFileBtx();
createCsvFileGx();

connectWebsocketBtx();
connectWebsocketGx();

setInterval(() => {
    makeStringBtx();
}, 1000);

setInterval(() => {
    makeStringGx();
}, 1000);

// websocket 연결을 후 작동할 수 있도록 0.5초 후 실행
setTimeout(() => {
    setInterval(() => {
        spreadGxBtx();
    }, 1000);
}, 500);
