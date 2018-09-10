var db = require('../db');
var issuer = require('../issuer');
var utils = require('../issuer/utils');

exports.payment = function (req, res) {
  var {
    coins,
    id,
    payment_id,
    merchant_data,
    memo,
    // The next params are  used for this demo,
    // it needs to be implemented
    client,
    language_preference,
    receipt_to,
    refund_to,
  } = req.body;

  if (!payment_id && !merchant_data) {
    res.status(400).send("Missing payment_id or merchant_data");
    return;
  }

  if (!coins || coins.length == 0) {
    res.status(400).send("No coins included");
    return;
  }

  var expires, key, tid, verifiedCoins, host,
    amount, currency, returnUrl, verifyInfo, account_id;

  var query = { 'payment_id': payment_id };

  db.findOne('payments', query).then((resp) => {
    if (!resp) {
      throw new Error("Can not find payment with payment_id " + payment_id);
    }

    if (resp.status == "resolved") {
      // The payment is resolved, throw error and intercept it
      var response = {
        PaymentAck: {
          status: "ok",
          id: id,
          return_url: resp.return_url,
        }
      };

      res.setHeader('Content-Type', 'application/json');
      console.log("*** PAYMENT COMPLETED AND CORRECT ***");
      res.send(JSON.stringify(response));
      throw new Error("-1");
    }

    amount = resp.amount;
    currency = resp.currency;
    expires = resp.expires;
    returnUrl = resp.return_url;

    var defIssuers = resp.issuers;
    console.log(defIssuers);

    if (!coins.every(c => currency == utils.Coin(c).c)) {
      throw new Error("Some coins are not from the requested currency");
    }

    if (utils.coinsValue(coins) < amount) {
      throw new Error("The coins sended are not enough");
    }

    // this is coming from issuer list
    var host = utils.Coin(coins[0]).d;
    var inIssuerList = (c) => {
      var domain = utils.Coin(c).d;
      var inList = defIssuers.indexOf(domain) > -1;
      return inList && domain == host;
    };

    if (defIssuers[0] != "*" && !coins.every(inIssuerList)) {
      throw new Error("Some coins are not from the list of acceptable issuers" +
        " or mixed coins are from different issuers."
      );
    }


    var prom1 = db.findAndModify("payments", query, { status: "processing" });
    var prom2 = issuer.post('begin', {
      issuerRequest: {
        fn: "verify"
      }
    }, host);
    var prom3 = db.findOne("accounts", {
      "_id": resp.account_id
    });
    return Promise.all([prom1, prom2, prom3]);
  }).then(([_p, vInfo, account]) => {
    verifyInfo = vInfo;
    tid = vInfo.issuerResponse.headerInfo.tid;
    account_id = account._id;

    var payload = {
      issuerRequest: {
        tid: tid,
        expiry: expires,
        coin: coins,
        targetValue: String(amount),
        issuePolicy: "single"
      }
    };

    console.log("coins to verify ", coins);
    return issuer.post('verify', payload, host);
  }).then((resp) => {
    verifiedCoins = resp.issuerResponse.coin;
    console.log("verified coins ", verifiedCoins);

    var value = resp.issuerResponse.verifyInfo.actualValue;
    if (value < amount) {
      throw new Error("After verify coins, the amount is not enough");
    }

    var coinData = {
      account_id: account_id,
      coins: verifiedCoins,
      currency: currency,
      date: new Date().toISOString(),
      value: value,
    }
    if (memo) coinData["memo"] = memo;
    if (client) coinData["client"] = client;
    if (payment_id) coinData["payment_id"] = payment_id;
    if (merchant_data) coinData["merchant_data"] = merchant_data;

    return db.insert("coins", coinData);
  }).then((records) => {
    var payData = {
      status: "resolved",
      verifyInfo: verifyInfo,
      paid: new Date().toISOString(),
    };
    if (memo) payData["memo"] = memo;
    if (client) payData["client"] = client;

    var prom1 = db.findAndModify("payments", query, payData);
    var prom2 = issuer.post('end', {
      issuerRequest: {
        tid: tid
      }
    }, host);

    return Promise.all([prom1, prom2]);
  }).then((responses) => {
    var response = {
      PaymentAck: {
        status: "ok",
        id: id,
        return_url: returnUrl
      }
    };
    res.setHeader('Content-Type', 'application/json');
    console.log("*** PAYMENT COMPLETED AND CORRECT ***");
    res.send(JSON.stringify(response));
  }).catch((err) => {
    if (err.message == "-1") {
      return;
    }
    res.status(400).send(err.message || err);
    return;
  });
}
