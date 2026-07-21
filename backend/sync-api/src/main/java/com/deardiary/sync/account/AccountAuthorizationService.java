package com.deardiary.sync.account;

import com.deardiary.sync.common.ApiException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class AccountAuthorizationService {
    private final JdbcTemplate jdbc;

    public AccountAuthorizationService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public SyncAccount requireActiveAccount(String ownerSubject) {
        var accounts = jdbc.query("""
            SELECT account_id, owner_subject, current_sequence, current_key_epoch,
                   minimum_read_protocol, minimum_write_protocol, account_status
            FROM sync_accounts WHERE owner_subject = ?
            """, (rs, row) -> new SyncAccount(
                rs.getObject("account_id", UUID.class), rs.getString("owner_subject"),
                rs.getLong("current_sequence"), rs.getInt("current_key_epoch"),
                rs.getInt("minimum_read_protocol"), rs.getInt("minimum_write_protocol"),
                rs.getString("account_status")), ownerSubject);
        if (accounts.isEmpty()) {
            throw new ApiException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND, "The synchronization account is not registered.");
        }
        var account = accounts.getFirst();
        if (!"ACTIVE".equals(account.status())) {
            throw new ApiException("ACCOUNT_NOT_ACTIVE", HttpStatus.CONFLICT,
                "The synchronization account is not active.", false, true, Map.of());
        }
        return account;
    }

    public record SyncAccount(
        UUID accountId,
        String ownerSubject,
        long currentSequence,
        int currentKeyEpoch,
        int minimumReadProtocol,
        int minimumWriteProtocol,
        String status
    ) {}
}
