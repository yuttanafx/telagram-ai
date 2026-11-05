//+------------------------------------------------------------------+
//| SignalHubAI.mqh                                                  |
//| Lets the Signal Hub AI pick the market regime, then applies the |
//| grid profile you set in the dashboard to Terravolteco SmartGold. |
//| Include it AFTER the dashboard globals (ebLotB, AutoB, ...).     |
//+------------------------------------------------------------------+
input string          AI_Url          = "https://your-app.vercel.app"; // Signal Hub URL (add it in Tools > Options > Expert Advisors > Allow WebRequest)
input string          AI_EAKey        = "";                             // your EA key (the admin gives it to you; it only works on your MT5 account number)
input ENUM_TIMEFRAMES AI_TF           = PERIOD_M15;                     // timeframe whose indicators are sent to the AI
input int             AI_PushSeconds  = 60;                             // how often to ask the server (server throttles by its own interval)
input int             AI_Bars         = 150;                            // candles sent to the hub for its chart and rule-based regime (60-300)
input double          AI_CapStartLot  = 0.10;                           // safety caps: the EA never applies more than these, whatever the server says
input double          AI_CapLotMult   = 2.0;
input int             AI_CapMaxOrders = 12;
input double          AI_CapRecMult   = 2.5;

bool     aiOn = true;
int      aiH_adx = INVALID_HANDLE, aiH_rsi = INVALID_HANDLE, aiH_atr = INVALID_HANDLE, aiH_e20 = INVALID_HANDLE, aiH_e50 = INVALID_HANDLE;
datetime aiLastPush = 0;
string   aiLastSig = "";
string   aiStatus = "AI: waiting for first reply";
CChartObjectButton btnAI;

string AI_Get(string &L[], int n, string key, string def = "")
{
   for(int i = 0; i < n; i++)
   {
      int p = StringFind(L[i], "=");
      if(p > 0 && StringSubstr(L[i], 0, p) == key) return StringSubstr(L[i], p + 1);
   }
   return def;
}

bool AI_Val(int h, double &v)
{
   double b[1];
   if(h == INVALID_HANDLE || CopyBuffer(h, 0, 1, 1, b) <= 0) return false; // last CLOSED bar
   v = b[0];
   return true;
}

void AI_ShowStatus()
{
   ObjectSetString(0, "TVE3_AILBL", OBJPROP_TEXT, aiStatus);
   ChartRedraw();
}

void AI_ButtonLook()
{
   btnAI.Description(aiOn ? "AI Profile: ON" : "AI Profile: OFF (manual)");
   btnAI.BackColor(aiOn ? clrDarkViolet : clrGray);
}

void AI_Init()
{
   aiH_adx = iADX(_Symbol, AI_TF, 14);
   aiH_rsi = iRSI(_Symbol, AI_TF, 14, PRICE_CLOSE);
   aiH_atr = iATR(_Symbol, AI_TF, 14);
   aiH_e20 = iMA(_Symbol, AI_TF, 20, 0, MODE_EMA, PRICE_CLOSE);
   aiH_e50 = iMA(_Symbol, AI_TF, 50, 0, MODE_EMA, PRICE_CLOSE);

   btnAI.Create(0, "TVE3_AIBTN", 0, 20, 540, 195, 25);
   btnAI.Color(clrWhite); btnAI.FontSize(9); btnAI.Selectable(false);
   AI_ButtonLook();
   ObjectCreate(0, "TVE3_AILBL", OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, "TVE3_AILBL", OBJPROP_XDISTANCE, 225);
   ObjectSetInteger(0, "TVE3_AILBL", OBJPROP_YDISTANCE, 546);
   ObjectSetInteger(0, "TVE3_AILBL", OBJPROP_COLOR, clrDarkSlateGray);
   ObjectSetString(0, "TVE3_AILBL", OBJPROP_TEXT, aiStatus);
}

void AI_Deinit()
{
   if(aiH_adx != INVALID_HANDLE) IndicatorRelease(aiH_adx);
   if(aiH_rsi != INVALID_HANDLE) IndicatorRelease(aiH_rsi);
   if(aiH_atr != INVALID_HANDLE) IndicatorRelease(aiH_atr);
   if(aiH_e20 != INVALID_HANDLE) IndicatorRelease(aiH_e20);
   if(aiH_e50 != INVALID_HANDLE) IndicatorRelease(aiH_e50);
}

void AI_Toggle()
{
   aiOn = !aiOn;
   AI_ButtonLook();
   aiStatus = aiOn ? "AI: turned on, asking server..." : "AI: off - you control the settings";
   aiLastPush = 0; aiLastSig = "";
   AI_ShowStatus();
}

bool AI_Request(const string body, string &resp)
{
   char post[], res[];
   string rh;
   int len = StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   if(len < 0) len = 0;
   ArrayResize(post, len);
   string headers = "Content-Type: application/json\r\nx-api-key: " + AI_EAKey + "\r\nx-account: " + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", AI_Url + "/api/ea/grid", headers, 8000, post, res, rh);
   if(code != 200)
   {
      aiStatus = "AI: request failed (HTTP " + IntegerToString(code) + ", err " + IntegerToString(GetLastError()) + ") - keeping current settings";
      return false;
   }
   resp = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   return true;
}

// Writes the profile into the dashboard boxes the EA already reads, plus the Auto Buy / Auto Sell switches.
void AI_Apply(string &L[], int n)
{
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double lot  = MathMax(minLot, MathMin(StringToDouble(AI_Get(L, n, "lot")), AI_CapStartLot));
   double lm   = MathMax(1.0, MathMin(StringToDouble(AI_Get(L, n, "lotMult")), AI_CapLotMult));
   int    stp  = (int)MathMax(50, StringToDouble(AI_Get(L, n, "step")));
   double sw   = MathMax(1.0, StringToDouble(AI_Get(L, n, "stepW")));
   double sa   = MathMax(1.0, StringToDouble(AI_Get(L, n, "stepA")));
   int    mx   = (int)MathMax(1, MathMin(StringToDouble(AI_Get(L, n, "max")), AI_CapMaxOrders));
   double tpn  = MathMax(0.5, StringToDouble(AI_Get(L, n, "tpN")));
   double tpo  = MathMax(0.5, StringToDouble(AI_Get(L, n, "tpO")));
   double rec  = MathMax(1.0, MathMin(StringToDouble(AI_Get(L, n, "recMult")), AI_CapRecMult));
   bool   buy  = (AI_Get(L, n, "buy") == "1");
   bool   sell = (AI_Get(L, n, "sell") == "1");

   string sLot = DoubleToString(lot, 2), sLm = DoubleToString(lm, 1), sStep = IntegerToString(stp);
   string sSw = DoubleToString(sw, 1), sSa = DoubleToString(sa, 1), sMax = IntegerToString(mx);
   string sTpn = DoubleToString(tpn, 1), sTpo = DoubleToString(tpo, 1);

   ebLotB.Description(sLot);   ebLotS.Description(sLot);
   ebLMultB.Description(sLm);  ebLMultS.Description(sLm);
   ebStepB.Description(sStep); ebStepS.Description(sStep);
   ebSMB.Description(sSw);     ebSMS.Description(sSw);
   ebSMAB.Description(sSa);    ebSMAS.Description(sSa);
   ebMaxB.Description(sMax);   ebMaxS.Description(sMax);
   ebTPB_D.Description(sTpn);  ebTPS_D.Description(sTpn);
   ebTPO_B.Description(sTpo);  ebTPO_S.Description(sTpo);
   InpRecMultiplier = rec;

   AutoB = buy;  btnAB.Description(AutoB ? "AutoBuy: ON"  : "AutoBuy: OFF");  btnAB.BackColor(AutoB ? clrLime : clrForestGreen);
   AutoS = sell; btnAS.Description(AutoS ? "AutoSell: ON" : "AutoSell: OFF"); btnAS.BackColor(AutoS ? clrRed  : clrFireBrick);
}

void AI_OnTick()
{
   if(!aiOn || MQLInfoInteger(MQL_TESTER)) return;          // WebRequest does not work in the Strategy Tester
   if(TimeCurrent() - aiLastPush < AI_PushSeconds) return;
   aiLastPush = TimeCurrent();

   double adx, rsi, atr, e20, e50;
   if(!AI_Val(aiH_adx, adx) || !AI_Val(aiH_rsi, rsi) || !AI_Val(aiH_atr, atr) || !AI_Val(aiH_e20, e20) || !AI_Val(aiH_e50, e50) || atr <= 0)
   { aiStatus = "AI: indicators not ready yet"; AI_ShowStatus(); return; }

   string body = StringFormat("{\"symbol\":\"%s\",\"tf\":\"%s\",\"price\":%.5f,\"adx\":%.2f,\"rsi\":%.2f,\"atr\":%.5f,\"ema20\":%.5f,\"ema50\":%.5f",
                              _Symbol, StringSubstr(EnumToString(AI_TF), 7), SymbolInfoDouble(_Symbol, SYMBOL_BID), adx, rsi, atr, e20, e50);
   // closed candles of AI_TF, oldest first: [time,open,high,low,close]
   MqlRates rt[];
   int want = (int)MathMax(60, MathMin(AI_Bars, 300));
   int got = CopyRates(_Symbol, AI_TF, 1, want, rt);
   if(got >= 60)
   {
      string bars = "";
      for(int i = 0; i < got; i++)
         bars += (i > 0 ? "," : "") + StringFormat("[%I64d,%.5f,%.5f,%.5f,%.5f]", (long)rt[i].time, rt[i].open, rt[i].high, rt[i].low, rt[i].close);
      body += ",\"bars\":[" + bars + "]";
   }
   body += "}";
   string resp;
   if(!AI_Request(body, resp)) { AI_ShowStatus(); return; }

   string L[];
   int n = StringSplit(resp, '\n', L);
   for(int i = 0; i < n; i++) { StringTrimLeft(L[i]); StringTrimRight(L[i]); }
   if(AI_Get(L, n, "ok") != "1") { aiStatus = "AI: unexpected reply - keeping current settings"; AI_ShowStatus(); return; }

   string regime = AI_Get(L, n, "regime"), prof = AI_Get(L, n, "profile"), sig = AI_Get(L, n, "sig");
   if(AI_Get(L, n, "hold") == "1")
      aiStatus = "AI: not confident (" + regime + ") - keeping current settings";
   else
   {
      if(sig != aiLastSig)
      {
         AI_Apply(L, n);
         aiLastSig = sig;
         Print("SignalHubAI: regime=", regime, " -> profile ", prof, " applied");
      }
      aiStatus = "AI: " + regime + " -> " + prof + " (" + AI_Get(L, n, "conf") + ")";
   }
   AI_ShowStatus();
}
