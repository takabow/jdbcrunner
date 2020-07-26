/*
 * Tiny TPC-C
 * This script is based on TPC-C Standard Specification 5.11.
 * http://tpc.org/tpcc/
 */

// JdbcRunner settings -----------------------------------------------

// Cloud Spanner JDBC - https://github.com/googleapis/java-spanner-jdbc
var jdbcUrl = "jdbc:cloudspanner:/projects/gcpx-db-demo/instances/dev-instance/databases/tpcc?retryAbortsInternally=true";

// Cloud Spanner doesn't use username/password
// var jdbcUser = ""; 
// var jdbcPass = "";
var warmupTime = 300;
var measurementTime = 900;
var nTxTypes = 5;
var nAgents = 16;
var stmtCacheSize = 40;
var isAutoCommit = false;
var logDir = "logs";

var warehouseId = 1;


// Application settings ----------------------------------------------

var DEADLOCK_RETRY_LIMIT = 1000;

// Using a constant value '100' for C-Run, and '0' for C-Load.
var C_255 = 100;
var C_1023 = 100;
var C_8191 = 100;

var SYLLABLE = [
    "BAR", "OUGHT", "ABLE", "PRI", "PRES",
    "ESE", "ANTI", "CALLY", "ATION", "EING"];

var scale;
var databaseProductName;

// Transaction sequence
var txSequence = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    2, 3, 4];

txSequence.index = txSequence.length;

txSequence.next = function() {
    if (this.index == this.length) {
        // Shuffle
        var rand;
        var swap;
        
        // Fisher-Yates algorithm
        for (var tail = this.length - 1; tail > 0; tail--) {
            rand = random(0, tail);
            swap = this[tail];
            this[tail] = this[rand];
            this[rand] = swap;
        }
        
        this.index = 0;
    }
    
    return this[this.index++];
}

// JdbcRunner functions ----------------------------------------------

function init() {
    if (getId() == 0) {
        info("Tiny TPC-C");
        
        putData("ScaleFactor", fetchAsArray("SELECT COUNT(*) FROM warehouse")[0][0]);
        info("Scale factor : " + Number(getData("ScaleFactor")));
        
        putData("DatabaseProductName", getDatabaseProductName());
        
        info("tx0 : New-Order transaction");
        info("tx1 : Payment transaction");
        info("tx2 : Order-Status transaction");
        info("tx3 : Delivery transaction");
        info("tx4 : Stock-Level transaction");
    }
    
    warehouseId = (getId() % 100) + 1
    //info(getId() + " " + warehouseId + " " + districtId);
}

function run() {
    if (!scale) {
        scale = Number(getData("ScaleFactor"));
    }
    
    if (!databaseProductName) {
        databaseProductName = getData("DatabaseProductName");
    }
    //var w_id = random(1, scale);　//倉庫を選び
    
    warehouseId = (getId() % 100) + 1
    switch (txSequence.next()) {
        case 0:
            setTxType(0);
            newOrder();
            break;
        case 1:
            setTxType(1);
            payment();
            break;
        case 2:
            setTxType(2);
            orderStatus();
            break;
        case 3:
            setTxType(3);
            delivery();
            break;
        case 4:
            setTxType(4);
            stockLevel();
            break;
    }
}

// Application functions ---------------------------------------------

function newOrder() {
    var w_id = warehouseId;
    //var w_id = random(1, scale);　//倉庫を選び
    var d_id = random(1, 10);   //区域を選び
    var c_id = nonUniformRandom(1023, 1, 3000);　//顧客選択
    var ol_cnt = random(5, 15); // 1回の注文数
    var all_local = 1;
    
    var i_id = new Array(ol_cnt); 
    var supply_w_id = new Array(ol_cnt);
    var quantity = new Array(ol_cnt);
    var order = new Array(ol_cnt);
    
    for (var index = 0; index < ol_cnt; index++) { 
        i_id[index] = nonUniformRandom(8191, 1, 100000); // 注文商品を選ぶ
        
        if ((scale > 1) && (random(1, 100) == 1)) { //1%の確率で、区域外の倉庫から商品を選ぶ（というレギュレーション）
            // A supplying warehouse number is selected as a remote warehouse 1% of the time.
            supply_w_id[index] = random(1, scale - 1);
            
            if (supply_w_id[index] >= w_id) {
                supply_w_id[index]++;
            }
            
            all_local = 0;
        } else {
            supply_w_id[index] = w_id;
        }
        
        quantity[index] = random(1, 10);
        order[index] = index;
    }
    
    // The items are sorted to avoid deadlock.
    order.sort(function(a, b) {
        return (supply_w_id[a] * 100000 + i_id[a]) - (supply_w_id[b] * 100000 + i_id[b]);
    });
    
    if (random(1, 100) == 1) {
        // A fixed 1% of the transactions are chosen to simulate user data entry errors.
        i_id[ol_cnt - 1] = 0;
    }
    
    for (var retry = 0; retry <= DEADLOCK_RETRY_LIMIT; retry++) {
        try {
            // 注文をした顧客の情報を取得、warehouse と customer で顧客は一意に特定
            var timeBegin = Date.now();
            var rc01 = query("SELECT /* N-01 */ ROUND(w.w_tax,4), c.c_discount, c.c_last, c.c_credit "
                           + "FROM warehouse w "
                           + "INNER JOIN customer c ON c.w_id = w.w_id "
                           + "WHERE w.w_id = $int AND c.d_id = $int AND c.c_id = $int",
                           w_id, d_id, c_id);
            var time1 = Date.now();

            // 顧客がいる倉庫-配送区域にて、注文IDを決めるために d_next_o_id を取得 （ここは完全にトランザクション間で競合）
            var rs02 = fetchAsArray("SELECT /* N-02 */ ROUND(d_tax,4), d_next_o_id "
                           + "FROM district "
                           + "WHERE w_id = $int AND d_id = $int ",
                           w_id, d_id);
            var time2 = Date.now();

            // 注文ID をインクリメント
            var uc03 = execute("UPDATE /* N-03 */ district "
                           + "SET d_next_o_id = d_next_o_id + 1 "
                           + "WHERE w_id = $int AND d_id = $int",
                           w_id, d_id);
            var time3 = Date.now();
            // o_id を先程取得した注文ID（d_next_o_id）とし、注文伝票作成
            var uc04 = execute("INSERT /* N-04 */ INTO orders "
                           + "(o_id, d_id, w_id, o_c_id, o_entry_d, "
                           + "o_carrier_id, o_ol_cnt, o_all_local) "
                           + "VALUES ($int, $int, $int, $int, $timestamp, "
                           + "NULL, $int, $int)",
                           rs02[0][1], d_id, w_id, c_id, new Date(),
                           ol_cnt, all_local);
            var time4 = Date.now();
            // 配送目的で新規注文管理用にこちらにも更新
            var uc05 = execute("INSERT /* N-05 */ INTO new_orders "
                           + "(o_id, d_id, w_id) "
                           + "VALUES ($int, $int, $int)",
                           rs02[0][1], d_id, w_id);
            var time5 = Date.now();
            // ここは注文数の数だけループ
            for (var index = 0; index < ol_cnt; index++) {
                // 注文対象商品の情報を取得
                var tf1 = Date.now();
                var rs06 = fetchAsArray("SELECT /* N-06 */ i_price, i_name, i_data "
                               + "FROM item "
                               + "WHERE i_id = $int",
                               i_id[order[index]]);
                
                // 存在しない注文がまじってたらまるごとロールバック
                if (rs06.length == 0) {
                    // An user data entry error occurred.
                    rollback();
                    return;
                }
                var tf2 = Date.now();
                // 注文商品の在庫情報を倉庫から取得
                var rs07 = fetchAsArray("SELECT /* N-07 */ s_quantity, "
                               + "s_dist_01, s_dist_02, s_dist_03, s_dist_04, s_dist_05, "
                               + "s_dist_06, s_dist_07, s_dist_08, s_dist_09, s_dist_10, s_data "
                               + "FROM stock "
                               + "WHERE s_i_id = $int AND w_id = $int ",
                               i_id[order[index]], supply_w_id[order[index]]);
                
                var stock = Number(rs07[0][0]) - quantity[order[index]];
                
                // Tiny TPC-C では在庫枯渇じの処理を端折っていて、枯渇がしないようにしてる
                if (stock < 10) {
                    // Notice: The sample code <A.1> is different from the specification <2.4.2.2>.
                    // The items will be filled up before running out of stock.
                    stock += 91;
                }
                
                var remote = (w_id == supply_w_id[order[index]]) ? 0 : 1;
                
                // 在庫を更新
                // Notice: The sample code <A.1> is different from the specification <2.4.2.2>.
                // The sample code only updates s_quantity.
                var tf3 = Date.now();

                var uc08 = execute("UPDATE /* N-08 */ stock "
                               + "SET s_quantity = $int, s_ytd = s_ytd + $int, "
                               + "s_order_cnt = s_order_cnt + 1, "
                               + "s_remote_cnt = s_remote_cnt + $int "
                               + "WHERE s_i_id = $int AND w_id = $int",
                               stock, quantity[order[index]], remote,
                               i_id[order[index]], supply_w_id[order[index]]);
                
                // 
                // Notice: The sample code <A.1> is different from the specification <2.4.2.2>.
                // c_discount, w_tax, d_tax are used for calculating total-amount, not ol_amount.
                var tf4 = Date.now();

                var uc09 = execute("INSERT /* N-09 */ INTO order_line "
                               + "(o_id, d_id, w_id, ol_number, ol_i_id, "
                               + "ol_supply_w_id, ol_delivery_d, ol_quantity, "
                               + "ol_amount, ol_dist_info) "
                               + "VALUES ($int, $int, $int, $int, $int, "
                               + "$int, NULL, $int, "
                               + "ROUND($double, 2), $string)",
                               rs02[0][1], d_id, w_id, index + 1, i_id[order[index]],
                               supply_w_id[order[index]], quantity[order[index]],
                               quantity[order[index]] * Number(rs06[0][0]), rs07[0][d_id]);
                var tf5 = Date.now();
                //info("[new order loop]" +(tf5-tf1)+ " " + (tf2-tf1) + " " + (tf3-tf2) + " " + (tf4-tf3) + " " + (tf5-tf4));
            }
            var time6 = Date.now();
            commit();
            var timeEnd = Date.now();
            //info("[new order] Elaped time: Total [" + retry + "] " + (timeEnd-timeBegin) + " " + (time1-timeBegin) + " " + (time2-time1) + " " + (time3-time2) + " " + (time4-time3) + " " + (time5-time4) + " " + (time6 - time5) + " " + (timeEnd-time6));
            info("[new order] Elaped time: Total:" + (timeEnd-timeBegin) + "ms [" + (time1-timeBegin) + " " + (time2-time1) + " " + (time3-time2) + " " + (time4-time3) + " " + (time5-time4) + " " + (time6 - time5) + " " + (timeEnd-time6) + "]");
            return;
        } catch (e) {
            if (isDeadlock(e)) {
                warn("[Agent " + getId() + "] " + e.javaException + getScriptStackTrace(e));
                rollback();
            } else {
                error(e + getScriptStackTrace(e));
            }
        }
    }
    
    error("The deadlock retry limit is reached.");
}

function payment() {
    var w_id = warehouseId;
    //var w_id = random(1, scale);
    var d_id = random(1, 10);
    var c_w_id = 0;
    var c_d_id = 0;
    var byName = false;
    var c_last = "";
    var c_id = 0;
    var h_amount = random(100, 500000) / 100;
    
    if (random(1, 100) <= 85) {
        // The customer is paying through his/her own warehouse.
        c_w_id = w_id;
        c_d_id = d_id;
    } else {
        // The customer is paying through a warehouse and a district other than his/her own.
        if (scale > 1) {
            c_w_id = random(1, scale - 1);
            
            if (c_w_id >= w_id) {
                c_w_id++;
            }
        } else {
            c_w_id = 1;
        }
        
        c_d_id = random(1, 10);
    }
    
    if (random(1, 100) <= 60) {
        // The customer is using his/her last name
        // and is one of the possibly several customers with that last name.
        byName = true;
        c_last = lastName(nonUniformRandom(255, 0, 999));
    } else {
        // The customer is using his/her customer number.
        byName = false;
        c_id = nonUniformRandom(1023, 1, 3000);
    }
    
    for (var retry = 0; retry <= DEADLOCK_RETRY_LIMIT; retry++) {
        try {
            var version = 100 * getDatabaseMajorVersion() + getDatabaseMinorVersion();
            
            // If RDBMS is PostgreSQL and version >= 9.3
            // use "FOR NO KEY UPDATE" instead of "FOR UPDATE" in P-01
            // to avoid deadlocks.
            var wSelectLockMode = "FOR UPDATE";
            
            if (databaseProductName == "PostgreSQL" && 903 <= version) {
                wSelectLockMode = "FOR NO KEY UPDATE";
            }
            
            // 倉庫の情報を取得
            var rs01 = fetchAsArray("SELECT /* P-01 */ "
                           + "w_name, w_street_1, w_street_2, w_city, w_state, w_zip "
                           + "FROM warehouse "
                           + "WHERE w_id = $int ",
                           w_id);
            
            // 倉庫の情報を直接書き換えててここがスレッド間で競合
            var uc02 = execute("UPDATE /* P-02 */ warehouse "
                           + "SET w_ytd = ROUND(w_ytd + $double, 2) "
                           + "WHERE w_id = $int",
                           h_amount,
                           w_id);
            
            var rs03 = fetchAsArray("SELECT /* P-03 */ "
                           + "d_name, d_street_1, d_street_2, d_city, d_state, d_zip "
                           + "FROM district "
                           + "WHERE w_id = $int AND d_id = $int ",
                           w_id, d_id);
            
            var uc04 = execute("UPDATE /* P-04 */ district "
                           + "SET d_ytd = ROUND(d_ytd + $double, 2) "
                           + "WHERE w_id = $int AND d_id = $int",
                           h_amount,
                           w_id, d_id);
            
            if (byName) {
                var rs05 = fetchAsArray("SELECT /* P-05 */ c_id "
                               + "FROM customer "
                               + "WHERE w_id = $int AND d_id = $int AND c_last = $string "
                               + "ORDER BY c_first",
                               c_w_id, c_d_id, c_last);
                
                if (rs05.length % 2 == 0) {
                    // Let n be the number of rows selected.
                    // The customer data is retrieved from the row at position n/2
                    // in the sorted set of selected rows from the CUSTOMER table.
                    c_id = Number(rs05[rs05.length / 2 - 1][0]);
                } else {
                    // The row position is rounded up to the next integer.
                    c_id = Number(rs05[(rs05.length + 1) / 2 - 1][0]);
                }
            }
            
            var rs06 = fetchAsArray("SELECT /* P-06 */ "
                           + "c_first, c_middle, c_last, c_street_1, c_street_2, "
                           + "c_city, c_state, c_zip, c_phone, c_since, c_credit, "
                           + "ROUND(c_credit_lim, 2), ROUND(c_discount, 4), ROUND(c_balance, 2), c_data "
                           + "FROM customer "
                           + "WHERE w_id = $int AND d_id = $int AND c_id = $int ",
                           c_w_id, c_d_id, c_id);
            
            if (rs06[0][10] == "BC") {
                // If the value of C_CREDIT is equal to "BC",
                // the following history information: C_ID, C_D_ID, C_W_ID, D_ID, W_ID,
                // and H_AMOUNT, are inserted at the left of the C_DATA field by shifting
                // the existing content of C_DATA to the right by an equal number of bytes.
                
                // Notice: The sample code <A.2> is different from the specification <2.5.2.2>.
                // According to the specification, h_date is not used to build c_data.
                var c_data = ("| " + c_id + " " + c_d_id + " " + c_w_id + " " + d_id + " "
                                 + w_id + " " + h_amount + " " + rs06[0][14]).substring(0, 500);
                
                // Notice: The sample code <A.2> is different from the specification <2.5.2.2>.
                // The sample code only updates c_balance and c_data.
                var uc07 = execute("UPDATE /* P-07 */ customer "
                               + "SET c_balance = ROUND(c_balance - $double, 2), "
                               + "c_ytd_payment = ROUND(c_ytd_payment + $double, 2), "
                               + "c_payment_cnt = c_payment_cnt + 1, "
                               + "c_data = $string "
                               + "WHERE w_id = $int AND d_id = $int AND c_id = $int",
                               h_amount, h_amount, c_data,
                               c_w_id, c_d_id, c_id);
            } else {
                // Notice: The sample code <A.2> is different from the specification <2.5.2.2>.
                // The sample code only updates c_balance.
                var uc08 = execute("UPDATE /* P-08 */ customer "
                               + "SET c_balance = ROUND(c_balance - $double, 2), "
                               + "c_ytd_payment = ROUND(c_ytd_payment + $double, 2), "
                               + "c_payment_cnt = c_payment_cnt + 1 "
                               + "WHERE w_id = $int AND d_id = $int AND c_id = $int",
                               h_amount, h_amount,
                               c_w_id, c_d_id, c_id);
            }
            
            var h_data = rs01[0][0] + "    " + rs03[0][0];
            var h_id = "" + w_id + d_id + c_id + random(1,1000000000); // 要調整
            var uc09 = execute("INSERT /* P-09 */ INTO history "
                           + "(h_id, h_c_id, h_c_d_id, h_c_w_id, h_d_id, h_w_id, "
                           + "h_date, h_amount, h_data) "
                           + "VALUES (FARM_FINGERPRINT($string), $int, $int, $int, $int, $int, "
                           + "$timestamp, $double, $string)",
                           h_id, c_id, c_d_id, c_w_id, d_id, w_id,
                           new Date(), h_amount, h_data);
            
            commit();
            return;
        } catch (e) {
            if (isDeadlock(e)) {
                warn("[Agent " + getId() + "] " + e.javaException + getScriptStackTrace(e));
                rollback();
            } else {
                error(e + getScriptStackTrace(e));
            }
        }
    }
    
    error("The deadlock retry limit is reached.");
}

function orderStatus() {
    var c_w_id = warehouseId;
    var c_w_id = random(1, scale);
    var c_d_id = random(1, 10);
    var byName = false;
    var c_last = "";
    var c_id = 0;

    setTransactionReadOnly();

    if (random(1, 100) <= 60) {
        // The customer is using his/her last name
        // and is one of the possibly several customers with that last name.
        byName = true;
        c_last = lastName(nonUniformRandom(255, 0, 999));
    } else {
        // The customer is using his/her customer number.
        byName = false;
        c_id = nonUniformRandom(1023, 1, 3000);
    }
    
    if (byName) {
        var rs01 = fetchAsArray("SELECT /* O-01 */ c_id "
                       + "FROM customer "
                       + "WHERE w_id = $int AND d_id = $int AND c_last = $string "
                       + "ORDER BY c_first",
                       c_w_id, c_d_id, c_last);
        
        if (rs01.length % 2 == 0) {
            // Let n be the number of rows selected.
            // The customer data is retrieved from the row at position n/2
            // in the sorted set of selected rows from the CUSTOMER table.
            c_id = Number(rs01[rs01.length / 2 - 1][0]);
        } else {
            // The row position is rounded up to the next integer.
            c_id = Number(rs01[(rs01.length + 1) / 2 - 1][0]);
        }
    }
    
    var rc02 = query("SELECT /* O-02 */ c_balance, c_first, c_middle, c_last "
                   + "FROM customer "
                   + "WHERE w_id = $int AND d_id = $int AND c_id = $int",
                   c_w_id, c_d_id, c_id);
    
    var rs03 = fetchAsArray("SELECT /* O-03 */ o1.o_id, o1.o_entry_d, o1.o_carrier_id "
                   + "FROM orders o1 "
                   + "WHERE o1.w_id = $int AND o1.d_id = $int "
                   + "AND o1.o_id = ("
                       + "SELECT MAX(o2.o_id) "
                       + "FROM orders o2 "
                       + "WHERE o2.w_id = $int AND o2.d_id = $int AND o2.o_c_id = $int"
                   + ")",
                   c_w_id, c_d_id, c_w_id, c_d_id, c_id);
    
    var rc04 = query("SELECT /* O-04 */ "
                   + "ol_i_id, ol_supply_w_id, ol_quantity, ROUND(ol_amount,2), ol_delivery_d "
                   + "FROM order_line "
                   + "WHERE w_id = $int AND d_id = $int AND o_id = $int",
                   c_w_id, c_d_id, rs03[0][0]);
    
    commit();
    setTransactionReadWrite()
}

function delivery() {
    var w_id = warehouseId;
    //var w_id = random(1, scale);
    var o_carrier_id = random(1, 10);
    
    for (var retry = 0; retry <= DEADLOCK_RETRY_LIMIT; retry++) {
        try {
            warehouse: for (;;) {
                district: for (var d_id = 1; d_id <= 10; d_id++) {

                    // ある倉庫、区域で未処理の中で一番古いオーダーIDを取得
                    var rs01 = fetchAsArray("SELECT /* D-01 */ MIN(o_id) "
                                + "FROM new_orders "
                                + "WHERE w_id = $int AND d_id = $int",
                                w_id, d_id);
                    
                    if (rs01[0][0] == null) {
                        // If no matching row is found,
                        // then the delivery of an order for this district is skipped.
                        continue district;
                    }
                    
                    // 取得したオーダーIDを new_order から削除
                    var uc02 = execute("DELETE /* D-02 */ "
                                   + "FROM new_orders "
                                   + "WHERE w_id = $int AND d_id = $int AND o_id = $int",
                                   w_id, d_id, rs01[0][0]);
                    
                    // 削除件数 0 件なら、処理失敗
                    if (uc02 == 0) {
                        // No row is deleted if another transaction have already done it.
                        // So we do rollback this transaction and retry it.
                        rollback();
                        continue warehouse;
                    }
                    
                    // オーダー詳細の今回の該当注文を取得
                    var rs03 = fetchAsArray("SELECT /* D-03 */ o_c_id "
                                   + "FROM orders "
                                   + "WHERE w_id = $int AND d_id = $int AND o_id = $int ",
                                   w_id, d_id, rs01[0][0]);
                    
                    // o_carrier_id を設定
                    var uc04 = execute("UPDATE /* D-04 */ orders "
                                   + "SET o_carrier_id = $int "
                                   + "WHERE w_id = $int AND d_id = $int AND o_id = $int",
                                   o_carrier_id,
                                   w_id, d_id, rs01[0][0]);
                    
                    var uc05 = execute("UPDATE /* D-05 */ order_line "
                                   + "SET ol_delivery_d = $timestamp "
                                   + "WHERE w_id = $int AND d_id = $int AND o_id = $int",
                                   new Date(), w_id, d_id, rs01[0][0]);
                    
                    var rs06 = fetchAsArray("SELECT /* D-06 */ SUM(ol_amount) "
                                   + "FROM order_line "
                                   + "WHERE w_id = $int AND d_id = $int AND o_id = $int",
                                   w_id, d_id, rs01[0][0]);
                    
                    // Notice: The sample code <A.4> is different from the specification <2.7.4.2>.
                    // The sample code only updates c_balance.
                    var uc07 = execute("UPDATE /* D-07 */ customer "
                                   + "SET c_balance = ROUND(c_balance + $double, 2), "
                                   + "c_delivery_cnt = c_delivery_cnt + 1 "
                                   + "WHERE w_id = $int AND d_id = $int AND c_id = $int",
                                   rs06[0][0], w_id, d_id, rs03[0][0]);
                }
                
                break;
            }
            
            commit();
            return;
        } catch (e) {
            if (isDeadlock(e)) {
                warn("[Agent " + getId() + "] " + e.javaException + getScriptStackTrace(e));
                rollback();
            } else {
                error(e + getScriptStackTrace(e));
            }
        }
    }
    
    error("The deadlock retry limit is reached.");
}

function stockLevel(w_id) {
    var w_id = warehouseId;
    //var w_id = random(1, scale);
    var d_id = random(1, 10);
    var threshold = random(10, 20);
    
    setTransactionReadOnly()

    var rc01 = query("SELECT /* S-01 */ /*+ USE_NL(ol s) */ COUNT(DISTINCT s.s_i_id) "
                   + "FROM district d "
                   + "INNER JOIN order_line ol ON ol.w_id = d.w_id AND ol.d_id = d.d_id "
                       + "AND ol.o_id BETWEEN d.d_next_o_id - 20 AND d.d_next_o_id - 1 "
                   + "INNER JOIN stock s ON s.w_id = ol.w_id AND s.s_i_id = ol.ol_i_id "
                   + "WHERE d.w_id = $int AND d.d_id = $int AND s.s_quantity < $int",
                   w_id, d_id, threshold);
    
    commit();
    setTransactionReadWrite()
}

function nonUniformRandom(a, x, y) {
    var c = 0;
    
    switch (a) {
        case 255:
            c = C_255;
            break;
        case 1023:
            c = C_1023;
            break;
        case 8191:
            c = C_8191;
            break;
        default:
            c = 0;
    }
    
    return (((random(0, a) | random(x, y)) + c) % (y - x + 1)) + x;
}

function lastName(seed) {
    return SYLLABLE[Math.floor(seed / 100)]
        + SYLLABLE[Math.floor(seed / 10) % 10]
        + SYLLABLE[seed % 10];
}

function isDeadlock(exception) {
    var javaException = exception.javaException;
    
    if (javaException instanceof java.sql.SQLException) {
        if (databaseProductName == "Oracle"
            && javaException.getErrorCode() == 60) {
            return true;
        } else if (databaseProductName == "MySQL"
            && javaException.getErrorCode() == 1213) {
            return true;
        } else if (databaseProductName == "PostgreSQL"
            && javaException.getSQLState() == "40P01") {
            return true;
        } else {
            return true; // Spanner easily throws abort
        }
    } else {
        return false;
    }
}


