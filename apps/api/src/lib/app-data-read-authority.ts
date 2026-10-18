/** Reads, local create/save and immutable resource plans use current data consent.
 * Resource review/release independently captures action authority. Unknown
 * operations and record action/lifecycle paths retain capture.
 * This selects work to capture; it does not cache any authority decision. */
const dataOnlyOperations=new Set(['prepare_resource_action','read_prepared_resource_action','record_list','record_read','record_create','record_save','file_read','connection_metadata',
 'record_prepare_change','record_apply_change','resource_list','resource_refresh','resource_read_metadata','resource_read_presentation','resource_list_files','resource_read_source','resource_read_file','resource_read_image']);
export function appDataConnectionActionSelection(operation?:string):'none'|undefined {
 return operation!==undefined&&dataOnlyOperations.has(operation)?'none':undefined;
}
/** Callback introspection returns data authority only. Record review brokers
 * independently check the selected action before/after preparation and release.
 * Keep the outer record-operation selection unchanged. */
export function appDataRuntimeConnectionActionSelection(operation:string):'none'|undefined {
 // File writes and their receipts are governed by current private-store consent;
 // this callback returns no action authority. Outer operation checks stay intact.
 return ['prepare_action','read_prepared','file_upload','file_detach','file_copy','request_status'].includes(operation)?'none':appDataConnectionActionSelection(operation);
}
