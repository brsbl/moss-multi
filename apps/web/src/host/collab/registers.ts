// Pure node seams are also loaded by the headless converter.
export {
  readRegister, writeRegister, readMapRegister, writeMapRegister, initRegisterNode, resetRegisterOnCopy, $assignRegisterIds,
  registerDoc, bindRegisters, REGISTER_LOCAL_ORIGIN,
} from '@moss-multi/sync/registers';
export { diffText } from '@moss-multi/core/text-diff';
