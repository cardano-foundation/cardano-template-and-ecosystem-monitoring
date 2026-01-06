// Status analyzer for 3-phase transformer monitoring

import { SensorData, StatusCode, StatusResult } from './types';

const STATUS_DEFINITIONS: Record<StatusCode, { name: string; severity: StatusResult['severity']; message: string }> = {
  [StatusCode.SYSTEM_NORMAL]: {
    name: 'SYSTEM_NORMAL',
    severity: 'NORMAL',
    message: '[OK] System Normal - All parameters within safe operating limits'
  },
  [StatusCode.CRITICAL_OVERLOAD]: {
    name: 'CRITICAL_OVERLOAD',
    severity: 'CRITICAL',
    message: '[CRITICAL] Overload detected! Phase current exceeds 100% of nominal rating'
  },
  [StatusCode.WARNING_HIGH_LOAD]: {
    name: 'WARNING_HIGH_LOAD',
    severity: 'WARNING',
    message: '[WARNING] High load detected! Phase current exceeds 80% of nominal rating'
  },
  [StatusCode.ALERT_UNDER_VOLTAGE]: {
    name: 'ALERT_UNDER_VOLTAGE',
    severity: 'ALERT',
    message: '[ALERT] Under voltage condition! Voltage below 200V threshold'
  },
  [StatusCode.ALERT_OVER_VOLTAGE]: {
    name: 'ALERT_OVER_VOLTAGE',
    severity: 'ALERT',
    message: '[ALERT] Over voltage condition! Voltage exceeds 240V threshold'
  },
  [StatusCode.WARNING_LOAD_IMBALANCE]: {
    name: 'WARNING_LOAD_IMBALANCE',
    severity: 'WARNING',
    message: '[WARNING] Load imbalance detected! Phase current difference exceeds 20%'
  },
  [StatusCode.CRITICAL_HIGH_TEMP]: {
    name: 'CRITICAL_HIGH_TEMP',
    severity: 'CRITICAL',
    message: '[CRITICAL] High temperature! Transformer temperature exceeds 80C'
  },
  [StatusCode.CRITICAL_PHASE_LOSS]: {
    name: 'CRITICAL_PHASE_LOSS',
    severity: 'CRITICAL',
    message: '[CRITICAL] Phase loss detected!'
  },
  [StatusCode.INFO_ZERO_LOAD]: {
    name: 'INFO_ZERO_LOAD',
    severity: 'INFO',
    message: '[INFO] Zero load - Transformer idle'
  }
};

export function analyzeStatus(data: SensorData): StatusResult {
  const { phase_voltage, phase_current, temperature, inom_setting } = data;
  
  const currents = [phase_current.R, phase_current.S, phase_current.T];
  const voltages = [phase_voltage.R, phase_voltage.S, phase_voltage.T];
  
  const maxCurrent = Math.max(...currents);
  const minCurrent = Math.min(...currents);
  const allCurrentsZero = currents.every(c => c === 0);
  const anyCurrentZero = currents.some(c => c === 0);
  const anyCurrentActive = currents.some(c => c > 0);
  
  if (anyCurrentZero && anyCurrentActive) {
    return createResult(StatusCode.CRITICAL_PHASE_LOSS);
  }
  
  if (maxCurrent > inom_setting) {
    return createResult(StatusCode.CRITICAL_OVERLOAD);
  }
  
  if (temperature > 80) {
    return createResult(StatusCode.CRITICAL_HIGH_TEMP);
  }
  
  if (voltages.some(v => v > 240)) {
    return createResult(StatusCode.ALERT_OVER_VOLTAGE);
  }
  
  if (voltages.some(v => v < 200 && v > 0)) {
    return createResult(StatusCode.ALERT_UNDER_VOLTAGE);
  }
  
  if (maxCurrent > inom_setting * 0.8) {
    return createResult(StatusCode.WARNING_HIGH_LOAD);
  }
  
  if (maxCurrent > 0) {
    const imbalance = ((maxCurrent - minCurrent) / maxCurrent) * 100;
    if (imbalance > 20) {
      return createResult(StatusCode.WARNING_LOAD_IMBALANCE);
    }
  }
  
  if (allCurrentsZero) {
    return createResult(StatusCode.INFO_ZERO_LOAD);
  }
  
  return createResult(StatusCode.SYSTEM_NORMAL);
}

function createResult(code: StatusCode): StatusResult {
  const def = STATUS_DEFINITIONS[code];
  return { code, name: def.name, message: def.message, severity: def.severity };
}

export function getStatusDefinition(code: StatusCode) {
  return STATUS_DEFINITIONS[code];
}

export function printStatus(data: SensorData, status: StatusResult): void {
  console.log('\n' + '-'.repeat(60));
  console.log('TRANSFORMER STATUS ANALYSIS');
  console.log('-'.repeat(60));
  console.log(`Device: ${data.device_id}`);
  console.log(`Time: ${new Date((data.timestamp || 0) * 1000).toISOString()}`);
  
  console.log('\nSensor Readings:');
  console.log(`  Phase R: ${data.phase_voltage.R} V, ${data.phase_current.R} A`);
  console.log(`  Phase S: ${data.phase_voltage.S} V, ${data.phase_current.S} A`);
  console.log(`  Phase T: ${data.phase_voltage.T} V, ${data.phase_current.T} A`);
  console.log(`  Temperature: ${data.temperature} C`);
  console.log(`  Nominal Current (Inom): ${data.inom_setting} A`);
  
  console.log('\n' + '-'.repeat(60));
  console.log(`Status Code: ${status.code} (${status.name})`);
  console.log(`Severity: ${status.severity}`);
  console.log(`${status.message}`);
  console.log('-'.repeat(60));
}
