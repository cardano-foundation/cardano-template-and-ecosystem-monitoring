// IoT Sentinel - Sensor Data Simulator

import { SensorData } from './lib/types';
import { analyzeStatus, printStatus } from './lib/analyzer';
import { saveSensorReading, addToRegistry, hashSensorData, printRegistrySummary } from './lib/data-manager';

const DEVICE_ID = 'TRAFO-SINJAI-01';
const INOM_SETTING = 100;

const rand = (base: number, range: number) => Math.round((base + (Math.random() - 0.5) * range * 2) * 10) / 10;

const SCENARIOS: Record<string, () => SensorData> = {
  normal: () => ({
    device_id: DEVICE_ID,
    phase_voltage: { R: rand(220, 2), S: rand(219, 2), T: rand(221, 2) },
    phase_current: { R: rand(50, 5), S: rand(49, 5), T: rand(51, 5) },
    temperature: rand(65, 5),
    inom_setting: INOM_SETTING,
    timestamp: Math.floor(Date.now() / 1000),
  }),

  overload: () => ({
    device_id: DEVICE_ID,
    phase_voltage: { R: rand(218, 3), S: rand(217, 3), T: rand(219, 3) },
    phase_current: { R: rand(110, 5), S: rand(108, 5), T: rand(112, 5) },
    temperature: rand(78, 3),
    inom_setting: INOM_SETTING,
    timestamp: Math.floor(Date.now() / 1000),
  }),

  hightemp: () => ({
    device_id: DEVICE_ID,
    phase_voltage: { R: rand(220, 2), S: rand(219, 2), T: rand(221, 2) },
    phase_current: { R: rand(70, 5), S: rand(69, 5), T: rand(71, 5) },
    temperature: rand(85, 3),
    inom_setting: INOM_SETTING,
    timestamp: Math.floor(Date.now() / 1000),
  }),

  undervoltage: () => ({
    device_id: DEVICE_ID,
    phase_voltage: { R: rand(190, 5), S: rand(188, 5), T: rand(191, 5) },
    phase_current: { R: rand(60, 5), S: rand(59, 5), T: rand(61, 5) },
    temperature: rand(70, 3),
    inom_setting: INOM_SETTING,
    timestamp: Math.floor(Date.now() / 1000),
  }),

  overvoltage: () => ({
    device_id: DEVICE_ID,
    phase_voltage: { R: rand(245, 3), S: rand(244, 3), T: rand(246, 3) },
    phase_current: { R: rand(55, 5), S: rand(54, 5), T: rand(56, 5) },
    temperature: rand(68, 3),
    inom_setting: INOM_SETTING,
    timestamp: Math.floor(Date.now() / 1000),
  }),

  phaseloss: () => ({
    device_id: DEVICE_ID,
    phase_voltage: { R: 220, S: 0, T: 221 },
    phase_current: { R: 60, S: 0, T: 62 },
    temperature: 72,
    inom_setting: INOM_SETTING,
    timestamp: Math.floor(Date.now() / 1000),
  }),
};

async function main(): Promise<void> {
  console.log('\nIoT SENTINEL - Sensor Data Simulator\n');

  const args = process.argv.slice(2);
  const scenarioArg = args.find(a => a.startsWith('--scenario='))?.split('=')[1] || 'normal';
  
  const validScenarios = Object.keys(SCENARIOS);
  if (!validScenarios.includes(scenarioArg)) {
    console.log(`Invalid scenario: ${scenarioArg}`);
    console.log(`Valid: ${validScenarios.join(', ')}`);
    return;
  }

  console.log(`Generating ${scenarioArg.toUpperCase()} scenario...\n`);

  const data = SCENARIOS[scenarioArg]();
  const status = analyzeStatus(data);
  printStatus(data, status);

  const filename = saveSensorReading(data);
  const hash = hashSensorData(data);
  const record = addToRegistry(filename, data, status.code, status.name);

  console.log(`\nSaved: data/readings/${filename}`);
  console.log(`Hash: ${hash}`);
  console.log(`Registry ID: ${record.id}`);

  printRegistrySummary();

  console.log('\nNext: npm run dev to submit to blockchain\n');
}

main().catch(console.error);
