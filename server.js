const express = require('express');
const cors = require('cors');
const axios = require('axios');
const qs = require('querystring');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════
// 🔑 SHIPSGO API
// ═══════════════════════════════════════
const AUTH = process.env.SHIPSGO_KEY || '284e7774-a60b-4b56-b389-44705cf3a058';
const BASE = 'https://shipsgo.com/api/v1.2/ContainerService';

// Carrier name mapping for ShipsGo
const CARRIER_MAP = {
  'MSC': 'MSC', 'Maersk': 'MAERSK LINE', 'CMA CGM': 'CMA CGM',
  'Hapag-Lloyd': 'HAPAG LLOYD', 'COSCO': 'COSCO', 'Evergreen': 'EVERGREEN',
  'ONE': 'ONE', 'Yang Ming': 'YANG MING', 'ZIM': 'ZIM',
};

// Prefix detection
const PREFIX = {
  MSCU:'MSC',MEDU:'MSC',MSMU:'MSC',
  MAEU:'MAERSK LINE',MSKU:'MAERSK LINE',MRKU:'MAERSK LINE',
  CMAU:'CMA CGM',CGMU:'CMA CGM',
  HLBU:'HAPAG LLOYD',HLCU:'HAPAG LLOYD',HLXU:'HAPAG LLOYD',
  CCLU:'COSCO',CSNU:'COSCO',CSQU:'COSCO',CBHU:'COSCO',
  EISU:'EVERGREEN',EGHU:'EVERGREEN',EMCU:'EVERGREEN',
  ONEY:'ONE',ONEU:'ONE',
  YMLU:'YANG MING',YMMU:'YANG MING',
  ZIMU:'ZIM',ZCSU:'ZIM',
};

// Reverse map for display names
const DISPLAY_NAME = {
  'MSC':'MSC','MAERSK LINE':'Maersk','CMA CGM':'CMA CGM',
  'HAPAG LLOYD':'Hapag-Lloyd','COSCO':'COSCO','EVERGREEN':'Evergreen',
  'ONE':'ONE','YANG MING':'Yang Ming','ZIM':'ZIM',
};

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ShipsGo Proxy', credits: 'check dashboard' }));

// ═══════════════════════════════════════
// POST /api/track — Track a container or BL
// ═══════════════════════════════════════
app.post('/api/track', async (req, res) => {
  const { number, carrier } = req.body;
  if (!number) return res.status(400).json({ success: false, error: 'Número requerido' });

  const num = number.trim().toUpperCase();
  const isContainer = /^[A-Z]{4}\d{7,}$/.test(num);

  // Detect shipping line
  let shippingLine = 'OTHERS';
  if (carrier && CARRIER_MAP[carrier]) {
    shippingLine = CARRIER_MAP[carrier];
  } else if (isContainer) {
    const pfx = num.substring(0, 4);
    if (PREFIX[pfx]) shippingLine = PREFIX[pfx];
  }

  try {
    // Step 1: POST to create tracking request
    let postUrl, postData;

    if (isContainer) {
      // Container number tracking
      postUrl = `${BASE}/PostContainerInfo`;
      postData = qs.stringify({
        authCode: AUTH,
        containerNumber: num,
        shippingLine: shippingLine,
      });
    } else {
      // BL number tracking
      postUrl = `${BASE}/PostBLContainerInfo`;
      postData = qs.stringify({
        authCode: AUTH,
        blContainersRef: num,
        shippingLine: shippingLine,
      });
    }

    let requestId = null;
    try {
      const postResp = await axios.post(postUrl, postData, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
      // Response should contain requestId
      if (postResp.data && postResp.data.RequestId) {
        requestId = postResp.data.RequestId;
      } else if (typeof postResp.data === 'number') {
        requestId = postResp.data;
      } else if (typeof postResp.data === 'string' && !isNaN(postResp.data)) {
        requestId = parseInt(postResp.data);
      }
    } catch (postErr) {
      // If already tracked, we can still GET data
      const errData = postErr.response?.data;
      console.log('POST response:', JSON.stringify(errData));
    }

    // Step 2: Wait a moment then GET voyage data
    await sleep(2000);

    // GET using the number directly (works as requestId)
    const getUrl = `${BASE}/GetContainerInfo?authCode=${AUTH}&requestId=${encodeURIComponent(num)}&mapPoint=true`;

    const getResp = await axios.get(getUrl, {
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    });

    const data = getResp.data;

    if (!data || (Array.isArray(data) && data.length === 0)) {
      return res.json({
        success: true,
        number: num,
        detectedCarrier: DISPLAY_NAME[shippingLine] || shippingLine,
        status: 'processing',
        message: 'Tracking creado. ShipsGo está procesando. Intenta en 5-10 minutos.',
        requestId,
      });
    }

    // Parse ShipsGo response
    const parsed = parseShipsGoData(data, num, shippingLine);
    return res.json(parsed);

  } catch (err) {
    console.error('Track error:', err.response?.data || err.message);
    return res.json({
      success: false,
      number: num,
      detectedCarrier: DISPLAY_NAME[shippingLine] || shippingLine,
      error: err.response?.data?.Message || err.message,
    });
  }
});

// ═══════════════════════════════════════
// GET /api/status/:number — Get tracking status only (no credit cost)
// ═══════════════════════════════════════
app.get('/api/status/:number', async (req, res) => {
  const num = req.params.number.trim().toUpperCase();

  try {
    const getUrl = `${BASE}/GetContainerInfo?authCode=${AUTH}&requestId=${encodeURIComponent(num)}&mapPoint=true`;
    const getResp = await axios.get(getUrl, {
      headers: { 'Accept': 'application/json' },
      timeout: 15000,
    });

    const data = getResp.data;
    if (!data || (Array.isArray(data) && data.length === 0)) {
      return res.json({ success: false, message: 'Sin datos disponibles' });
    }

    const parsed = parseShipsGoData(data, num, '');
    return res.json(parsed);
  } catch (err) {
    return res.json({ success: false, error: err.response?.data?.Message || err.message });
  }
});

// ═══════════════════════════════════════
// GET /api/carriers — List supported carriers
// ═══════════════════════════════════════
app.get('/api/carriers', async (req, res) => {
  try {
    const resp = await axios.get(`${BASE}/GetShippingLineList?authCode=${AUTH}`, {
      headers: { 'Accept': 'application/json' },
      timeout: 10000,
    });
    res.json({ success: true, carriers: resp.data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// PARSE SHIPSGO DATA
// ═══════════════════════════════════════
function parseShipsGoData(data, number, shippingLine) {
  // ShipsGo returns different formats depending on container vs BL
  // It can be an object or nested structure

  let containers = [];
  let events = [];
  let shipmentData = {};

  // Handle if data is the voyage object directly
  if (data && !Array.isArray(data)) {
    shipmentData = data;
  } else if (Array.isArray(data) && data.length > 0) {
    shipmentData = data[0];
  }

  // Extract main fields
  const sd = shipmentData;

  // ShipsGo fields vary, try common patterns
  const origin = sd.DeparturePort || sd.FromPort || sd.PortOfLoading || sd.departurePort || '';
  const destination = sd.ArrivalPort || sd.ToPort || sd.PortOfDischarge || sd.arrivalPort || '';
  const eta = sd.EstimatedArrivalDate || sd.ETA || sd.ArrivalDate || sd.estimatedArrivalDate || '';
  const etd = sd.EstimatedDepartureDate || sd.ETD || sd.DepartureDate || sd.estimatedDepartureDate || '';
  const vessel = sd.VesselName || sd.Vessel || sd.vesselName || '';
  const voyage = sd.VoyageNumber || sd.Voyage || sd.voyageNumber || '';
  const status = sd.TransportStatus || sd.Status || sd.status || sd.ShipmentStatus || '';
  const bl = sd.BLNumber || sd.BlNumber || sd.MasterBLNumber || sd.blNumber || '';
  const containerNum = sd.ContainerNumber || sd.containerNumber || number;
  const carrier = sd.ShippingLine || sd.Carrier || sd.shippingLine || DISPLAY_NAME[shippingLine] || shippingLine;
  const containerType = sd.ContainerType || sd.containerType || '';

  // Map coordinates
  const lat = sd.Latitude || sd.latitude || sd.MapPointLat || null;
  const lng = sd.Longitude || sd.longitude || sd.MapPointLng || null;

  // Extract movement/event history
  const movements = sd.Movements || sd.ContainerMovements || sd.movements || sd.Events || [];
  if (Array.isArray(movements)) {
    events = movements.map(m => ({
      date: m.ActualDate || m.Date || m.date || m.EventDate || '',
      description: m.Description || m.Event || m.description || m.Status || m.Movement || '',
      location: m.Location || m.Port || m.location || m.Place || '',
      vessel: m.VesselName || m.Vessel || '',
      isActual: m.IsActual !== undefined ? m.IsActual : true,
    }));
  }

  // Extract containers list if BL tracking
  const containersList = sd.Containers || sd.ContainerList || [];
  if (Array.isArray(containersList) && containersList.length > 0) {
    containers = containersList.map(c => ({
      number: c.ContainerNumber || c.containerNumber || c.Number || '',
      type: c.ContainerType || c.containerType || c.Type || '',
      status: c.Status || c.status || '',
    }));
  }

  const hasData = !!(origin || destination || eta || vessel || events.length > 0);

  return {
    success: true,
    hasData,
    number,
    detectedCarrier: carrier,
    shippingLine: carrier,
    billOfLading: bl,
    containerNumber: containerNum,
    containerType,
    status,
    portOfLading: origin,
    portOfDischarge: destination,
    eta: eta,
    etd: etd,
    vesselName: vessel,
    voyageNumber: voyage,
    latitude: lat,
    longitude: lng,
    containers,
    events,
    message: hasData ? 'Datos obtenidos exitosamente' : 'Tracking creado, datos en procesamiento. Intenta en 5-10 min.',
    raw: sd,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
  console.log(`🚢 ShipsGo Proxy en puerto ${PORT}`);
  console.log(`   POST /api/track         — Rastrear contenedor/BL`);
  console.log(`   GET  /api/status/:num   — Consultar datos (sin gastar crédito)`);
  console.log(`   GET  /api/carriers      — Lista de navieras`);
});
