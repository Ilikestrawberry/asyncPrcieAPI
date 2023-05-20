const http2 = require('http2');
const fs = require('fs');


// ------------------------------------------global variable
let gClient = {};
const gSymbols = 'BTC_KRW'
const gOrderbook = {
  [gSymbols]: {
    bid: [],
    ask: []
  }
};

const gIntervalRequest = setInterval(() => {
    requestClient();
  }, 1000);

const gIntervalCsv = setInterval(() => {
  makeString(5);   //5호가
  }, 1000);

// ------------------------------------------function
function requestClient() {
    gClient = http2.connect('https://api.bithumb.com');

    const req = gClient.request({
        ':path': `/public/orderbook/BTC_KRW`
    });

    let data = '';
    req.on('data', (chunk) => {
        data += chunk
    });
    
    req.on('end', () => {
        const ret = JSON.parse(data);
        getOrderbookBtx(ret);
    });

    req.on('error', (error) => {
        console.error(error);
    });
};

function getOrderbookBtx(data) {
    const bid = data.data.bids;
    const ask = data.data.asks;

    gOrderbook[gSymbols] = {
        bid,
        ask
    };
};

function createCsvFile() {
    const filePath = './bithumb_btc_5_orderbook.csv';
    if (fs.existsSync(filePath)) {
        return;
    };
    const stream = fs.createWriteStream('./bithumb_btc_5_orderbook.csv');
    let columnName = 'time';
    const lowerSymbol = gSymbols.toLowerCase();
    for (i = 1; i <= 5; i++) {
        columnName += `, btx.${lowerSymbol}krw.b${i}p, btx.${lowerSymbol}krw.b${i}q, btx.${lowerSymbol}krw.a${i}p, btx.${lowerSymbol}krw.a${i}q`
    };
    stream.write(`${columnName}\n`);
    stream.end();
};

function makeString(num) {
    if (gOrderbook[gSymbols].hasOwnProperty('bid') && gOrderbook[gSymbols].bid.length) {
        let string = Date.now();
        const bidLength = gOrderbook[gSymbols].bid.length
        for (i = 0; i < num; i++) {
        string += ',' + gOrderbook[gSymbols].bid[bidLength - 1 - i].price + ',' + gOrderbook[gSymbols].bid[bidLength - 1 - i].quantity + ',' + gOrderbook[gSymbols].ask[i].price + ',' + gOrderbook[gSymbols].ask[i].quantity
        };
        string += '\n';
        appendToCsvFile(string);
    };
};

function appendToCsvFile(string) {
    const stream = fs.createWriteStream('./bithumb_btc_5_orderbook.csv', { flags: 'a' });
    stream.write(string);
    stream.end();
};

function main() {
    console.log('main');
    gIntervalRequest;
    gIntervalCsv;
};


// ------------------------------------------operation
createCsvFile();

main();