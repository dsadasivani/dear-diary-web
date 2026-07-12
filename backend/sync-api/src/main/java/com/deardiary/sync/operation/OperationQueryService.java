package com.deardiary.sync.operation;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class OperationQueryService {
    private final JdbcTemplate jdbc;
    private final AccountAuthorizationService accounts;

    public OperationQueryService(JdbcTemplate jdbc, AccountAuthorizationService accounts) {
        this.jdbc = jdbc;
        this.accounts = accounts;
    }

    public OperationStatusResponse find(String ownerSubject, UUID operationId) {
        var account = accounts.requireActiveAccount(ownerSubject);
        var rows = jdbc.query("""
            SELECT operation_status, committed_sequence, committed_record_version, last_error_code
            FROM sync_operations WHERE account_id = ? AND operation_id = ?
            """, (rs, row) -> new OperationStatusResponse(
                operationId, rs.getString(1), (Long) rs.getObject(2),
                (Long) rs.getObject(3), rs.getString(4)), account.accountId(), operationId);
        if (rows.isEmpty()) {
            throw new ApiException("OPERATION_NOT_FOUND", HttpStatus.NOT_FOUND, "The synchronization operation was not found.");
        }
        return rows.getFirst();
    }
}
