#include <stdio.h>
#include <string.h>
#include <stdbool.h>

/**
 * Desafio: 2025 Holiday Season Challenge
 * Caso de Uso: Ferramenta Auxiliar Off-chain para Validação de Endereços Cardano
 */

// Tabela de caracteres permitidos no formato Bech32 (exclui o, i, l, 1)
const char* CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// Função simples para verificar se um caractere faz parte do charset Bech32
bool is_valid_bech32_char(char c) {
    if (c == '1') return true; // Separador
    for (int i = 0; i < 32; i++) {
        if (CHARSET[i] == c) return true;
    }
    return false;
}

// Valida se a string tem o formato básico de um endereço da mainnet Cardano (addr1...)
bool validate_cardano_prefix(const char* address) {
    const char* prefix = "addr1";
    if (strncmp(address, prefix, 5) != 0) {
        printf("Erro: Prefixo invalido. Enderecos Cardano Mainnet devem começar com 'addr1'.\n");
        return false;
    }
    
    for (int i = 0; address[i] != '\0'; i++) {
        if (!is_valid_bech32_char(address[i])) {
            printf("Erro: Caractere invalido detectado: %c\n", address[i]);
            return false;
        }
    }
    
    return true;
}

int main() {
    // Exemplo de endereço (encurtado para teste)
    char test_addr[] = "addr1q9h6...z7q"; 

    printf("--- Cardano Address Validator (C Implementation) ---\n");
    printf("Validando: %s\n", test_addr);

    if (validate_cardano_prefix(test_addr)) {
        printf("Resultado: O formato do prefixo e caracteres sao validos!\n");
    } else {
        printf("Resultado: Endereco invalido.\n");
    }

    return 0;
}
