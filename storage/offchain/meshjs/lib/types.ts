// Type definitions for IoT Sentinel

export interface PhaseVoltage {
  R: number;
  S: number;
  T: number;
}

export interface PhaseCurrent {
  R: number;
  S: number;
  T: number;
}

export interface SensorData {
  device_id: string;
  phase_voltage: PhaseVoltage;
  phase_current: PhaseCurrent;
  temperature: number;
  inom_setting: number;
  timestamp?: number;
}

export enum StatusCode {
  SYSTEM_NORMAL = 0,
  CRITICAL_OVERLOAD = 1,
  WARNING_HIGH_LOAD = 2,
  ALERT_UNDER_VOLTAGE = 3,
  ALERT_OVER_VOLTAGE = 4,
  WARNING_LOAD_IMBALANCE = 5,
  CRITICAL_HIGH_TEMP = 6,
  CRITICAL_PHASE_LOSS = 7,
  INFO_ZERO_LOAD = 8,
}

export interface StatusResult {
  code: StatusCode;
  name: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'ALERT' | 'CRITICAL' | 'NORMAL';
}

export interface IoTRecordDatum {
  owner: string;
  device_id: string;
  timestamp: number;
  data_hash: string;
  status_code: number;
}

export interface TxResult {
  txHash: string;
  success: boolean;
  message?: string;
}
