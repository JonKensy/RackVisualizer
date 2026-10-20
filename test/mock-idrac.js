// Mock iDRAC Redfish endpoint for end-to-end testing without real credentials.
// Test-only: lives under test/ and is never copied into the production image.
// Serves a self-signed HTTPS Redfish API. Location can be provided either via
// the canonical Chassis Location.Info (MOCK_CHASSIS_INFO) or via an OEM field
// on the System (MOCK_LOCATION) to exercise the defensive string-walk fallback.
// Configure via env: MOCK_TAG, MOCK_MODEL, MOCK_LOCATION, MOCK_CHASSIS_INFO,
// MOCK_CPUS, MOCK_CPU_MODEL, MOCK_THREADS, MOCK_RAM_GIB.
import https from 'node:https';
import fs from 'node:fs';

const TAG = process.env.MOCK_TAG ?? 'MOCKTAG1';
const MODEL = process.env.MOCK_MODEL ?? 'PowerEdge R740';
const LOCATION = process.env.MOCK_LOCATION ?? '';
const CHASSIS_INFO = process.env.MOCK_CHASSIS_INFO ?? ';;;;0';
const CPUS = Number(process.env.MOCK_CPUS ?? 2);
const CPU_MODEL = process.env.MOCK_CPU_MODEL ?? 'Intel Xeon Gold 6130';
const THREADS = Number(process.env.MOCK_THREADS ?? 32);
const RAM_GIB = Number(process.env.MOCK_RAM_GIB ?? 256);

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
    '@odata.id': `/redfish/v1/Systems/${TAG}`,
    Model: MODEL,
    ProcessorSummary: { Count: CPUS, Model: CPU_MODEL, LogicalProcessorCount: THREADS },
    MemorySummary: { TotalSystemMemoryGiB: RAM_GIB },
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
  // NetworkAdapters → Ports with LLDPReceive, mirroring real iDRAC9 firmware
  // (PortId is colon-separated hex of the switch interface name).
  [`/redfish/v1/Systems/${TAG}/NetworkAdapters`]: {
    Members: [{ '@odata.id': `/redfish/v1/Chassis/${TAG}/NetworkAdapters/NIC.Slot.1` }],
  },
  [`/redfish/v1/Chassis/${TAG}/NetworkAdapters/NIC.Slot.1`]: {
    Id: 'NIC.Slot.1',
    Model: 'Mock 10GbE 2P',
    Ports: { '@odata.id': `/redfish/v1/Chassis/${TAG}/NetworkAdapters/NIC.Slot.1/Ports` },
  },
  [`/redfish/v1/Chassis/${TAG}/NetworkAdapters/NIC.Slot.1/Ports`]: {
    Members: [
      { '@odata.id': `/redfish/v1/Chassis/${TAG}/NetworkAdapters/NIC.Slot.1/Ports/NIC.Slot.1-1` },
      { '@odata.id': `/redfish/v1/Chassis/${TAG}/NetworkAdapters/NIC.Slot.1/Ports/NIC.Slot.1-2` },
    ],
  },
  [`/redfish/v1/Chassis/${TAG}/NetworkAdapters/NIC.Slot.1/Ports/NIC.Slot.1-1`]: {
    Id: 'NIC.Slot.1-1',
    LinkStatus: 'LinkUp',
    CurrentSpeedGbps: 10,
    Ethernet: {
      AssociatedMACAddresses: ['AA:BB:CC:DD:EE:01'],
      LLDPReceive: {
        ChassisId: '00:1c:73:0f:64:a2',
        ChassisIdSubtype: 'MacAddr',
        PortId: '45:74:68:65:72:6E:65:74:31',
        PortIdSubtype: 'IfName',
      },
    },
  },
  [`/redfish/v1/Chassis/${TAG}/NetworkAdapters/NIC.Slot.1/Ports/NIC.Slot.1-2`]: {
    Id: 'NIC.Slot.1-2',
    LinkStatus: 'NoLink',
    Ethernet: { AssociatedMACAddresses: ['AA:BB:CC:DD:EE:02'] },
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
