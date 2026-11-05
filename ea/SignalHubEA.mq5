//+------------------------------------------------------------------+
//| SignalHubEA.mq5 - polls the Signal Hub on Vercel and trades       |
//| Setup: Tools > Options > Expert Advisors > Allow WebRequest       |
//|        add your https://YOUR-APP.vercel.app URL to the list.      |
//+------------------------------------------------------------------+
#property strict
#include <Trade/Trade.mqh>

input string          ServerUrl      = "https://YOUR-APP.vercel.app"; // no trailing slash
input string          ApiKey         = "";        // same as EA_API_KEY on Vercel
input int             PollSeconds    = 3;         // 3-5 recommended (each poll = 1 serverless call)
input bool            SendIndicators = true;      // send closed-bar indicators to the AI
input int             PushSeconds    = 60;        // how often to offer data to the server (the server throttles by the interval set in the dashboard)
input ENUM_TIMEFRAMES SignalTF       = PERIOD_M15;
input double          SignalLot      = 0.01;      // lot used for AI-generated signals
input string          SymbolSuffix   = "";        // broker suffix, e.g. "m" for XAUUSDm
input long            MagicNumber    = 20260101;
input int             Deviation      = 20;

CTrade   trade;
int      hEma20, hEma50, hRsi, hAdx, hAtr;
datetime lastPush = 0;

int OnInit()
{
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(Deviation);
   hEma20 = iMA(_Symbol, SignalTF, 20, 0, MODE_EMA, PRICE_CLOSE);
   hEma50 = iMA(_Symbol, SignalTF, 50, 0, MODE_EMA, PRICE_CLOSE);
   hRsi   = iRSI(_Symbol, SignalTF, 14, PRICE_CLOSE);
   hAdx   = iADX(_Symbol, SignalTF, 14);
   hAtr   = iATR(_Symbol, SignalTF, 14);
   EventSetTimer(PollSeconds);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

string Http(string method, string path, string body, int &code)
{
   char data[], result[];
   string rh;
   string headers = "Content-Type: application/json\r\nx-api-key: " + ApiKey + "\r\nx-account: " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\r\n";
   if(StringLen(body) > 0) StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   ResetLastError();
   code = WebRequest(method, ServerUrl + path, headers, 8000, data, result, rh);
   if(code == -1) Print("WebRequest error ", GetLastError(), " - is the URL allowed in Options?");
   return CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
}

double Buf(int handle)
{
   double b[1];
   if(CopyBuffer(handle, 0, 1, 1, b) != 1) return 0;   // shift 1 = last closed bar
   return b[0];
}

void PushIndicators()
{
   string sym = _Symbol;
   if(StringLen(SymbolSuffix) > 0 && StringFind(sym, SymbolSuffix) == StringLen(sym) - StringLen(SymbolSuffix))
      sym = StringSubstr(sym, 0, StringLen(sym) - StringLen(SymbolSuffix));
   double price = iClose(_Symbol, SignalTF, 1);
   string body = StringFormat(
      "{\"symbol\":\"%s\",\"tf\":\"%s\",\"price\":%.5f,\"ema20\":%.5f,\"ema50\":%.5f,\"rsi\":%.2f,\"adx\":%.2f,\"atr\":%.5f,\"lot\":%.2f,\"execute\":true}",
      sym, EnumToString(SignalTF), price, Buf(hEma20), Buf(hEma50), Buf(hRsi), Buf(hAdx), Buf(hAtr), SignalLot);
   int code;
   Http("POST", "/api/ai/decide", body, code);
}

void Report(string id, bool ok, ulong ticket, double price, string note)
{
   int code;
   Http("POST", "/api/ea/report", id + "|" + (ok ? "done" : "failed") + "|" + (string)ticket + "|" + DoubleToString(price, 5) + "|" + note, code);
}

void Execute(string line)
{
   string p[];
   if(StringSplit(line, '|', p) < 6) return;
   string id = p[0], sym = p[1] + SymbolSuffix, side = p[2];
   double lot = StringToDouble(p[3]), sl = StringToDouble(p[4]), tp = StringToDouble(p[5]);
   if(!SymbolSelect(sym, true)) { Report(id, false, 0, 0, "symbol not found"); return; }
   bool ok = (side == "BUY") ? trade.Buy(lot, sym, 0, sl, tp, id) : trade.Sell(lot, sym, 0, sl, tp, id);
   uint rc = trade.ResultRetcode();
   ok = ok && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED);
   Report(id, ok, trade.ResultOrder(), trade.ResultPrice(), ok ? "" : "retcode " + (string)rc);
}

void OnTimer()
{
   int code;
   string resp = Http("GET", "/api/ea/poll", "", code);
   if(code == 200 && StringLen(resp) > 0)
   {
      string lines[];
      int n = StringSplit(resp, '\n', lines);
      for(int i = 0; i < n; i++) if(StringLen(lines[i]) > 5) Execute(lines[i]);
   }
   if(SendIndicators && TimeCurrent() - lastPush >= PushSeconds)
   {
      lastPush = TimeCurrent();
      PushIndicators();
   }
}
