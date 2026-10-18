// Reviewed fresh117 fingerprints retain CRLF inside these two legacy function
// bodies. Preserve files/checksums; converge only their fresh execution text.
export function freshBootstrapSql(file,sql){
 if(!['0020_wiki_search_vector.sql','0081_modules_v1.sql'].includes(file))return sql;
 return sql.replace(/\r?\n/g,'\r\n');
}
