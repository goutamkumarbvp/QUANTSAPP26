@echo off
rem Q26 Options: checks whether this PC can reach NSE, BSE and Kotak (no login, no credentials).
cd /d "%~dp0"
echo Checking network from this PC ...
echo.
node -e "const u=['https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20260923_F_0000.csv.zip','https://archives.nseindia.com/content/indices/ind_close_all_23092026.csv','https://www.nseindia.com/','https://www.bseindia.com/','https://mis.kotaksecurities.com/'];const h={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36','Accept':'*/*'};(async()=>{for(const x of u){try{const r=await fetch(x,{headers:h,signal:AbortSignal.timeout(20000)});console.log('OK   HTTP '+r.status+'  '+x)}catch(e){const c=e.cause||{};const i=(c.errors&&c.errors[0])||c;console.log('FAIL '+x+'\n     '+e.message+' | '+(c.code||i.code||'')+' '+(i.message||c.message||''))}}})()"
echo.
echo "OK HTTP 200/403/404" = reachable. "FAIL" = blocked by network, firewall, antivirus or ISP.
echo Send this window's text to support.
pause
