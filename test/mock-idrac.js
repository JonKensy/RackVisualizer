// Mock iDRAC Redfish endpoint for end-to-end testing without real credentials.
// Test-only: lives under test/ and is never copied into the production image.
// Serves a self-signed HTTPS Redfish API. Location can be provided either via
// the canonical Chassis Location.Info (MOCK_CHASSIS_INFO) or via an OEM field
// on the System (MOCK_LOCATION) to exercise the defensive string-walk fallback.
// Configure via env: MOCK_TAG, MOCK_MODEL, MOCK_LOCATION, MOCK_CHASSIS_INFO.
import https from 'node:https';
import fs from 'node:fs';

const TAG = process.env.MOCK_TAG ?? 'MOCKTAG1';
const MODEL = process.env.MOCK_MODEL ?? 'PowerEdge R740';
const LOCATION = process.env.MOCK_LOCATION ?? '';
const CHASSIS_INFO = process.env.MOCK_CHASSIS_INFO ?? ';;;;0';

const routes = {
  '/redfish/v1': {
    RedfishVersion: '1.17.0',
    Oem: { Dell: { ServiceTag: TAG } },
  },
  '/redfish/v1/Systems': {
    Members: [{ '@odata.id': `/redfish/v1/Systems/${TAG}`, Id: TAG }],
  },
  [`/redfish/v1/Systems/${TAG}`]: {
    Id: TAG,
    Model: MODEL,
    Links: { Chassis: [{ '@odata.id': `/redfish/v1/Chassis/${TAG}` }] },
    Oem: { Dell: { SystemLocation: LOCATION } },
  },
  [`/redfish/v1/Chassis/${TAG}`]: {
    Id: TAG,
    Model: MODEL,
    Location: { Info: CHASSIS_INFO, Placement: { Rack: '', RackOffset: 0 } },
  },
  [`/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/DellAttributes/${TAG}`]: {
    Attributes: { 'SystemInfo.1.SysLocation': LOCATION },
  },
};

https
  .createServer(
    { key: fs.readFileSync('/certs/key.pem'), cert: fs.readFileSync('/certs/cert.pem') },
    (req, res) => {
      const body = routes[req.url];
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body ?? { error: 'not found' }));
    },
  )
  .listen(443, () => console.log(`mock iDRAC ${TAG} listening on 443`));
