000100*> Copybook: ACCTREC — account master record layout.
000200*> Shared by ACCOUNT-BATCH and the online inquiry program.
000300 01  WS-ACCOUNT-RECORD.
000400     05  WS-ACCT-ID       PIC 9(10).
000500     05  WS-ACCT-NAME     PIC X(30).
000600     05  WS-ACCT-BALANCE  PIC S9(9)V99 COMP-3.
000700     05  WS-ACCT-STATUS   PIC X(1).
000800*> End of ACCTREC.
